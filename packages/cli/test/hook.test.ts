import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "abide-hook.js",
);
const home = mkdtempSync(path.join(tmpdir(), "abide-home-"));

// Each test's repo gets its own abide home, so sessions frozen in one test
// never leak into another that happens to reuse a session id.
const run = (name: string, input: string) => {
  let homeForRun = home;
  try {
    const cwd = JSON.parse(input)?.cwd;
    if (typeof cwd === "string") {
      // One stable, unique home per test repo: repeated calls in one test
      // share its sessions, while separate tests never inherit them, and it
      // stays outside the repo so git never snapshots abide's own state.
      homeForRun = path.join(tmpdir(), `abide-home-${path.basename(cwd)}`);
    }
  } catch {
    // garbage stdin keeps the shared home
  }
  return spawnSync("node", [script, name], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: "",
      TYPESAFE_AI_API_KEY: "",
      ABIDE_HOME_DIR: homeForRun,
    },
    timeout: 25_000,
  });
};

const rubricWith = (rules: unknown[]): string =>
  JSON.stringify({ version: 1, compiledAt: "x", sources: [{ path: "AGENTS.md" }], rules });

const repoWith = (rules: unknown[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".abide"));
  writeFileSync(path.join(root, ".abide", "rubric.json"), rubricWith(rules));
  return root;
};

describe("the hook never breaks the agent (needs `pnpm build` first)", () => {
  for (const name of ["session-start", "turn-start", "post-tool-use", "stop"]) {
    it(`${name}: garbage in, exit 0 and nothing on stdout`, () => {
      for (const input of [
        "",
        "not json",
        "{}",
        '{"hook_event_name":"PostToolUse","tool_name":"Bash"}',
      ]) {
        const r = run(name, input);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
      }
    });
  }

  it("post-tool-use without a rubric or key is silent and exits 0", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
    const payload = {
      session_id: "t",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "a.ts"), content: "export interface X {}\n" },
      tool_response: { originalFile: null, structuredPatch: [] },
    };
    const r = run("post-tool-use", JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("a diff that cannot be computed in time is skipped, logged, and never holds the hook", () => {
    const root = repoWith([
      {
        id: "r",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    const lines = (prefix: string) =>
      Array.from({ length: 30_000 }, (_, i) => `${prefix}${i} ${Math.random()}`).join("\n");
    const payload = {
      session_id: "t",
      prompt_id: "p",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "big.ts"), content: lines("new") },
      tool_response: { originalFile: lines("old"), structuredPatch: [] },
    };
    const started = performance.now();
    const r = run("post-tool-use", JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(10_000);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8");
    expect(events).toContain("diff too large to compute in time");
  }, 20_000);

  it("turn-start snapshots a git repo and stop then sees a change made by a shell", () => {
    const root = repoWith([
      {
        id: "scope-creep",
        text: "No features beyond what was asked",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    const start = run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    expect(start.status).toBe(0);
    expect(start.stdout).toBe("");
    writeFileSync(path.join(root, "made-by-shell.ts"), "export const x = 1;\n");
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8");
    expect(events).toContain('"made-by-shell.ts"');
    expect(events).toContain('"reason":"no api key"');
  });

  it("a shell deletion is part of the turn diff", () => {
    const root = repoWith([
      {
        id: "scope-creep",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    writeFileSync(path.join(root, "doomed.ts"), "export const gone = 1;\n");
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    rmSync(path.join(root, "doomed.ts"));
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8");
    expect(events).toContain('"doomed.ts"');
  });

  it("a git clean filter that hangs cannot hold turn-start past its budget", () => {
    const root = repoWith([]);
    execSync(
      "git init -q . && git config filter.slow.clean 'sleep 30; cat' && printf '*.ts filter=slow\\n' > .gitattributes && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    writeFileSync(path.join(root, "slow.ts"), "export const slow = 1;\n");
    const started = performance.now();
    const r = run(
      "turn-start",
      JSON.stringify({
        session_id: "slow-filter",
        prompt_id: "p",
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt: "go",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it("a turn whose files cannot all be diffed in time is skipped and named, not judged in part", () => {
    const root = repoWith([
      {
        id: "single-use-abstraction",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    const lines = (prefix: string) =>
      Array.from({ length: 30_000 }, (_, i) => `${prefix}${i} ${Math.random()}`).join("\n");
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    // Not a git repository, so Stop takes the per-file path.
    base.session_id = "incomplete-files";
    writeFileSync(path.join(root, "helper.ts"), "export const helper = 1;\n");
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      const file = path.join(root, name);
      writeFileSync(file, lines("new"));
      run(
        "post-tool-use",
        JSON.stringify({
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: file, content: lines("new") },
          tool_response: { originalFile: lines("old"), structuredPatch: [] },
        }),
      );
    }
    run(
      "post-tool-use",
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(root, "helper.ts"),
          content: "export const helper = 1;\n",
        },
        tool_response: { originalFile: null, structuredPatch: [] },
      }),
    );
    const started = performance.now();
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(15_000);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const turnEvents = events.filter((e) => e.phase === "turn");
    expect(turnEvents.map((e) => e.kind)).toEqual(["skip"]);
    expect(turnEvents[0].reason).toContain("turn diff incomplete");
    expect(turnEvents[0].files).toContain("a.ts");
  }, 90_000);

  it("a failed turn-start snapshot makes the turn incomplete, for mixed and shell-only turns alike", () => {
    const turnRule = {
      id: "single-use-abstraction",
      text: "t",
      source: { path: "AGENTS.md" },
      when: "turn",
      check: { type: "model", question: { type: "boolean", instructions: "?" } },
    };
    for (const mixed of [true, false]) {
      const root = repoWith([turnRule]);
      execSync(
        "git init -q . && git config filter.bad.clean false && git config filter.bad.required true && printf '*.ts filter=bad\\n' > .gitattributes && git add .gitattributes AGENTS.md .abide && git -c user.email=a@b -c user.name=a commit -q -m init",
        { cwd: root },
      );
      writeFileSync(path.join(root, "seed.ts"), "export const seed = 1;\n");
      const base = {
        session_id: mixed ? "failed-mixed" : "failed-shell-only",
        prompt_id: "p",
        cwd: root,
      };
      const start = run(
        "turn-start",
        JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
      );
      expect(start.status).toBe(0);
      if (mixed) {
        const helper = path.join(root, "helper.ts");
        writeFileSync(helper, "export const helper = 1;\n");
        run(
          "post-tool-use",
          JSON.stringify({
            ...base,
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_input: { file_path: helper, content: "export const helper = 1;\n" },
            tool_response: { originalFile: null, structuredPatch: [] },
          }),
        );
      }
      writeFileSync(path.join(root, "callers.ts"), "import { helper } from './helper';\n");
      const stop = run(
        "stop",
        JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
      );
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe("");
      const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const turnEvents = events.filter((e) => e.phase === "turn");
      expect(turnEvents.map((e) => e.kind)).toEqual(["skip"]);
      expect(turnEvents[0].reason).toContain("turn start");
    }
  }, 60_000);

  const turnRule = () => ({
    id: "single-use-abstraction",
    text: "t",
    source: { path: "AGENTS.md" },
    when: "turn",
    check: { type: "model", question: { type: "boolean", instructions: "?" } },
  });

  it("a duplicate hook delivery records one event, across two separate processes", () => {
    const root = repoWith([turnRule()]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "dup-session", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    writeFileSync(path.join(root, "made.ts"), "export const x = 1;\n");
    const payload = JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false });
    const first = run("stop", payload);
    const retry = run("stop", payload);
    expect(first.status).toBe(0);
    expect(retry.status).toBe(0);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const commits = events.filter((e) => e.kind === "session-commit");
    // No API key in the test env, so the turn judge is skipped; the commit
    // still happens exactly once and still names the covered file.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(["made.ts"]);
    expect(events.filter((e) => e.kind === "check")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "skip")).toHaveLength(1);
  });

  it("rules rewritten mid-turn conflict on commit with both fingerprints", () => {
    const root = repoWith([turnRule()]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "rules-change", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    writeFileSync(path.join(root, "made.ts"), "export const x = 1;\n");
    // The compiled rules change while the turn is in flight.
    writeFileSync(
      path.join(root, ".abide", "rubric.json"),
      rubricWith([
        {
          ...turnRule(),
          text: "a rule that was rewritten while the turn was running",
        },
      ]),
    );
    const stop = run("stop", JSON.stringify({ ...base, hook_event_name: "Stop" }));
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).not.toContain("session-commit");
    const conflict = events.find((e) => e.kind === "session-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.conflicts.some((c: { kind: string }) => c.kind === "rules")).toBe(true);
    const rulesConflict = conflict.conflicts.find((c: { kind: string }) => c.kind === "rules");
    expect(rulesConflict.oldFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesConflict.newFingerprint).not.toBe(rulesConflict.oldFingerprint);
  });

  it("a file the edit judge saw, then a shell rewrote without a recorded edit, conflicts", () => {
    const root = repoWith([
      {
        id: "single-use-abstraction",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "drift-session", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    const target = path.join(root, "made.ts");
    // The edit judge sees v1 through a recorded Write.
    run(
      "post-tool-use",
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: target, content: "export const x = 1;\n" },
        tool_response: { originalFile: null, structuredPatch: [] },
      }),
    );
    // Then a shell rewrites it after the edit check, with no tool hook.
    writeFileSync(target, "export const x = 99; // changed outside the recorded edits\n");
    const stop = run("stop", JSON.stringify({ ...base, hook_event_name: "Stop" }));
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).not.toContain("session-commit");
    const conflict = events.find((e) => e.kind === "session-conflict");
    expect(conflict).toBeDefined();
    const fileConflict = conflict.conflicts.find((c: { kind: string }) => c.kind === "files");
    expect(fileConflict.drifted).toContain("made.ts");
  }, 30_000);

  it("commits after a restart: a later process reads the frozen snapshot and commits", () => {
    const root = repoWith([turnRule()]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "restart-session", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    writeFileSync(path.join(root, "made.ts"), "export const x = 1;\n");
    // A brand new process (the "restart") runs stop against the on-disk snapshot.
    const stop = run("stop", JSON.stringify({ ...base, hook_event_name: "Stop" }));
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const commit = events.find((e) => e.kind === "session-commit");
    expect(commit).toBeDefined();
    expect(commit?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(commit?.files).toEqual(["made.ts"]);
  });

  it("session-start in a repo with an AGENTS.md and no rubric asks for a compile", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
    writeFileSync(path.join(root, "AGENTS.md"), "- Use type, never interface\n");
    const r = run(
      "session-start",
      JSON.stringify({
        session_id: "t",
        cwd: root,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("compile-skill.md");
    expect(out.hookSpecificOutput.additionalContext).toContain("AGENTS.md");
    expect(out.systemMessage).toContain("no API key");
  });
});
