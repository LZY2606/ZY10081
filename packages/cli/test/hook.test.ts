import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "abide-hook.js",
);
const home = mkdtempSync(path.join(tmpdir(), "abide-home-"));

const run = (name: string, input: string) =>
  spawnSync("node", [script, name], {
    input,
    encoding: "utf8",
    env: { ...process.env, AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "", ABIDE_HOME_DIR: home },
    timeout: 25_000,
  });

const sourceSha = (root: string): string =>
  createHash("sha256")
    .update(readFileSync(path.join(root, "AGENTS.md")))
    .digest("hex");

const rubricWith = (rules: unknown[], root?: string): string =>
  JSON.stringify({
    version: 1,
    compiledAt: "x",
    sources: [{ path: "AGENTS.md", ...(root ? { sha: sourceSha(root) } : {}) }],
    rules,
  });

const repoWith = (rules: unknown[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".abide"));
  writeFileSync(path.join(root, ".abide", "rubric.json"), rubricWith(rules, root));
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
    const base = { session_id: "shell-add", prompt_id: "p", cwd: root };
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
    const base = { session_id: "shell-del", prompt_id: "p", cwd: root };
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

const editRule = {
  id: "say-why",
  text: "say why",
  source: { path: "AGENTS.md" },
  when: "edit",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
} as const;

const sessionRepo = (rule: unknown = editRule): { root: string; home: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  const home = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- say why\n");
  mkdirSync(path.join(root, ".abide"));
  writeFileSync(path.join(root, ".abide", "rubric.json"), rubricWith([rule], root));
  return { root, home };
};

const runIn = (home: string, name: string, input: unknown) =>
  spawnSync("node", [script, name], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "", ABIDE_HOME_DIR: home },
    timeout: 25_000,
  });

const readEventsIn = (root: string) =>
  readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

const editContent = "export const why = 1;\n";

const editPayload = (root: string, sessionId: string, file = "a.ts", toolId = "tool-1") => {
  // The host applies the write before PostToolUse fires, so the file is on disk.
  writeFileSync(path.join(root, file), editContent);
  return {
    session_id: sessionId,
    prompt_id: "p",
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_use_id: toolId,
    tool_input: { file_path: path.join(root, file), content: editContent },
    tool_response: { originalFile: null, structuredPatch: [] },
  };
};

describe("immutable check session (needs `pnpm build` first)", () => {
  it("a rule file changed mid-session withholds the verdict as a rules conflict naming both fingerprints", () => {
    const { root, home } = sessionRepo();
    const sessionId = "mid-rules";
    // First edit establishes the snapshot against the original rules.
    runIn(home, "post-tool-use", editPayload(root, sessionId, "a.ts", "tool-1"));
    // The instruction file changes before the next delivery.
    writeFileSync(path.join(root, "AGENTS.md"), "- never use the letter e\n");
    const r = runIn(home, "post-tool-use", editPayload(root, sessionId, "b.ts", "tool-2"));
    expect(r.status).toBe(0);
    const events = readEventsIn(root);
    const conflict = events.filter((e) => e.kind === "session-conflict");
    expect(conflict).toHaveLength(1);
    expect(conflict[0].what).toBe("rules");
    expect(conflict[0].oldFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(conflict[0].newFingerprint).not.toBe(conflict[0].oldFingerprint);
    expect(conflict[0].affectedRules).toContain("say-why");
    expect(JSON.stringify(r.stdout)).toContain("rebase");
  });

  it("an external change to a covered file is reported as a files conflict, not checked against it", () => {
    const { root, home } = sessionRepo();
    const sessionId = "ext-drift";
    runIn(home, "post-tool-use", editPayload(root, sessionId, "a.ts", "tool-1"));
    // The second delivery reports the same on-disk content the host just wrote.
    const second = editPayload(root, sessionId, "a.ts", "tool-2");
    // Then something outside the hooks rewrites that file before the check commits.
    writeFileSync(path.join(root, "a.ts"), "export const tampered = true;\n");
    const r = runIn(home, "post-tool-use", second);
    expect(r.status).toBe(0);
    const events = readEventsIn(root);
    const conflict = events.filter((e) => e.kind === "session-conflict");
    expect(conflict.map((c) => c.what)).toContain("files");
    expect(conflict.flatMap((c) => c.files)).toContain("a.ts");
  });

  it("a retried hook with the same session and event id commits one event and one verdict set", () => {
    const { root, home } = sessionRepo();
    const sessionId = "dup-hook";
    const payload = editPayload(root, sessionId, "a.ts", "same-tool");
    runIn(home, "post-tool-use", payload);
    runIn(home, "post-tool-use", payload);
    const events = readEventsIn(root);
    const ids = events.map((e) => e.eventId).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.filter((e) => e.kind === "skip" && e.eventId !== undefined)).toHaveLength(1);
  });

  it("commits a verdict after a restart with no half audit", () => {
    const { root, home } = sessionRepo();
    const sessionId = "restart-commit";
    runIn(home, "post-tool-use", editPayload(root, sessionId, "a.ts", "tool-1"));
    const eventsBefore = readEventsIn(root).length;
    // A second, distinct delivery after "restart": still one event per id.
    runIn(home, "post-tool-use", editPayload(root, sessionId, "b.ts", "tool-2"));
    const events = readEventsIn(root);
    expect(events.length).toBe(eventsBefore + 1);
    const everyLineHasId = events.every((e) => typeof e.eventId === "string");
    expect(everyLineHasId).toBe(true);
    // The snapshot survived: it is the same rule version across the restart.
    const snapshot = JSON.parse(
      readFileSync(
        path.join(home, ".abide", "sessions", sessionId, ".session", "snapshot.json"),
        "utf8",
      ),
    );
    expect(snapshot.rules.map((rule: { id: string }) => rule.id)).toEqual(["say-why"]);
  });

  it("deliveries from different host tools in either order leave one verdict per delivery", () => {
    const { root, home } = sessionRepo();
    const sessionId = "host-order";
    const first = editPayload(root, sessionId, "a.ts", "host-tool-a");
    const second = editPayload(root, sessionId, "b.ts", "host-tool-b");
    runIn(home, "post-tool-use", second);
    runIn(home, "post-tool-use", first);
    const events = readEventsIn(root).filter((e) => e.kind === "skip");
    const files = events.flatMap((e) => e.files ?? []).sort();
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  it("two adapters delivering the same event at once leave one audit line", async () => {
    const { spawn } = await import("node:child_process");
    const { root, home } = sessionRepo();
    const sessionId = "concurrent-adapters";
    const payload = editPayload(root, sessionId, "a.ts", "same-delivery");
    const deliver = () =>
      new Promise<void>((resolve) => {
        const child = spawn("node", [script, "post-tool-use"], {
          env: {
            ...process.env,
            AI_GATEWAY_API_KEY: "",
            TYPESAFE_AI_API_KEY: "",
            ABIDE_HOME_DIR: home,
          },
        });
        child.on("close", () => resolve());
        child.stdin.end(JSON.stringify(payload));
      });
    await Promise.all([deliver(), deliver()]);
    const events = readEventsIn(root);
    const forDelivery = events.filter((e) => e.files?.includes("a.ts"));
    expect(forDelivery).toHaveLength(1);
  });
});
