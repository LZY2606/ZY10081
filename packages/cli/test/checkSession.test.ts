import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MergedRule } from "../src/lib/rubricFile.js";
import {
  appendEvidence,
  ensureSession,
  liveSessionId,
  markSession,
  readSessionStatus,
  readSnapshot,
  rebaseSession,
  removeSession,
  sessionDir,
  validateCommit,
  type OpenedSession,
} from "../src/lib/checkSession.js";
import { appendEventOnce, readEvents } from "../src/lib/events.js";
import { createBlobId, type AbideEvent } from "@coldtea/abide-schema";

const rule = (id: string, text = "t"): MergedRule => ({
  id,
  text,
  source: { path: "AGENTS.md" },
  when: "edit",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
  status: "active",
  origin: "project",
});

let root: string;
let home: string;

const open = (
  sessionId: string,
  over: { rules?: MergedRule[]; sha?: string } = {},
): OpenedSession => {
  const sha = over.sha ?? "a".repeat(64);
  writeFileSync(path.join(root, "AGENTS.md"), sha.slice(0, 8));
  const opened = ensureSession({
    sessionId,
    root,
    rules: over.rules ?? [rule("r-one")],
    thresholds: { act: 0.8, flag: 0.5 },
    projectSources: [{ path: "AGENTS.md", sha }],
    globalSources: [],
  });
  if (opened === undefined) throw new Error("session did not open");
  return opened;
};

describe("check sessions", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abide-session-repo-"));
    home = mkdtempSync(path.join(tmpdir(), "abide-session-home-"));
    process.env.ABIDE_HOME_DIR = home;
  });
  afterEach(() => {
    delete process.env.ABIDE_HOME_DIR;
  });

  it("freezes rules once: a second opener gets the same snapshot and fingerprint", () => {
    const first = open("s");
    // The instruction file changes on disk before the second hook runs.
    writeFileSync(path.join(root, "AGENTS.md"), "completely different instructions now");
    const second = open("s", { sha: "b".repeat(64) });
    expect(second.created).toBe(false);
    expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    expect(second.rules.map((r) => r.id)).toEqual(["r-one"]);
    expect(readSnapshot("s")?.fingerprint).toBe(first.snapshot.fingerprint);
  });

  it("stores no absolute home path, no credentials and no raw file contents", () => {
    writeFileSync(path.join(root, ".env"), "TYPESAFE_AI_API_KEY=sk-secret-1234");
    const opened = open("s");
    const file = path.join(sessionDir("s"), "snapshot.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(home);
    expect(raw).not.toContain("sk-secret-1234");
    expect(raw).not.toContain("completely different");
    expect(raw).not.toContain("TYPESAFE_AI_API_KEY");
    expect(opened.snapshot.root).toBe(".");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("serializes and restores after a restart, from disk only", () => {
    const opened = open("s");
    const afterRestart = readSnapshot("s");
    expect(afterRestart?.fingerprint).toBe(opened.snapshot.fingerprint);
    expect(afterRestart?.rules[0]?.id).toBe("r-one");
    expect(readSessionStatus("s")?.status).toBe("active");
  });

  it("commits clean when nothing moved, and names covered files", () => {
    const opened = open("s");
    writeFileSync(path.join(root, "AGENTS.md"), "unchanged source");
    writeFileSync(path.join(root, "a.ts"), "content a");
    const blobAfter = createBlobId("content a");
    const result = validateCommit(
      {
        sessionId: "s",
        turnId: "p",
        currentFingerprint: opened.snapshot.fingerprint ?? "",
        changedSources: [],
        files: ["a.ts"],
        verdicts: [{ ruleId: "r-one", band: "clear", files: ["a.ts"] }],
        judgedAfter: new Map([["a.ts", blobAfter]]),
        blobNow: () => blobAfter,
      },
      opened.snapshot,
    );
    expect(result.status).toBe("clean");
  });

  it("flags a mid-session rule change with old and new fingerprints and all verdicts affected", () => {
    const opened = open("s");
    writeFileSync(path.join(root, "a.ts"), "a");
    const result = validateCommit(
      {
        sessionId: "s",
        turnId: "p",
        currentFingerprint: "f".repeat(64),
        changedSources: ["AGENTS.md"],
        files: ["a.ts"],
        verdicts: [
          { ruleId: "r-one", band: "act", files: ["a.ts"] },
          { ruleId: "r-two", band: "clear", files: ["other.ts"] },
        ],
        judgedAfter: new Map([["a.ts", "x"]]),
        blobNow: () => "x",
      },
      opened.snapshot,
    );
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") throw new Error("expected conflict");
    const rulesConflict = result.conflicts.find((c) => c.kind === "rules");
    expect(rulesConflict).toBeDefined();
    if (rulesConflict?.kind !== "rules") throw new Error("expected rules conflict");
    expect(rulesConflict.oldFingerprint).toBe(opened.snapshot.fingerprint);
    expect(rulesConflict.newFingerprint).toBe("f".repeat(64));
    expect(rulesConflict.changedSources).toEqual(["AGENTS.md"]);
    expect(result.affected.map((v) => v.ruleId).sort()).toEqual(["r-one", "r-two"]);
  });

  it("flags external file drift, but accepts changes made through recorded edit evidence", () => {
    const opened = open("s");
    writeFileSync(path.join(root, "a.ts"), "v2");
    appendEvidence(opened.dir, "p", "e1", {
      kind: "edit",
      turnId: "p",
      at: "now",
      eventId: "e1",
      path: "a.ts",
      before: "v1",
      after: "v2",
      verdicts: [{ ruleId: "r-one", band: "act", files: ["a.ts"] }],
    });
    const seen = validateCommit(
      {
        sessionId: "s",
        turnId: "p",
        currentFingerprint: opened.snapshot.fingerprint ?? "",
        changedSources: [],
        files: ["a.ts"],
        verdicts: [{ ruleId: "r-one", band: "act", files: ["a.ts"] }],
        judgedAfter: new Map<string, string | null>([["a.ts", "v2"]]),
        blobNow: () => "v2",
      },
      opened.snapshot,
    );
    expect(seen.status).toBe("clean");

    // A shell writes v3, which no recorded edit chain explains.
    const drifted = validateCommit(
      {
        sessionId: "s",
        turnId: "p",
        currentFingerprint: opened.snapshot.fingerprint ?? "",
        changedSources: [],
        files: ["a.ts", "b.ts"],
        verdicts: [
          { ruleId: "r-one", band: "act", files: ["a.ts"] },
          { ruleId: "r-one", band: "flag", files: ["b.ts"] },
        ],
        judgedAfter: new Map<string, string | null>([
          ["a.ts", "v2"],
          ["b.ts", "v1"],
        ]),
        blobNow: (file) => (file === "a.ts" ? "v3" : "v1"),
      },
      opened.snapshot,
    );
    expect(drifted.status).toBe("conflict");
    if (drifted.status !== "conflict") throw new Error("expected conflict");
    const fileConflict = drifted.conflicts.find((c) => c.kind === "files");
    expect(fileConflict).toEqual({ kind: "files", drifted: ["a.ts"] });
    expect(drifted.affected.map((v) => v.files.join())).toEqual(["a.ts"]);
  });

  it("rebases into a fresh generation against the new rules and keeps the old snapshot archived", () => {
    const opened = open("s");
    markSession("s", "conflicted", 0);
    const next = rebaseSession("s", {
      root,
      rules: [rule("r-one", "rewritten rule text"), rule("r-two")],
      thresholds: { act: 0.8, flag: 0.5 },
      projectSources: [{ path: "AGENTS.md", sha: "b".repeat(64) }],
      globalSources: [],
    });
    expect(next.status).toBe("ok");
    if (next.status !== "ok") throw new Error("rebase failed");
    expect(next.newSessionId).toBe("s#2");
    expect(next.snapshot.generation).toBe(1);
    expect(next.snapshot.rules.map((r) => r.id).sort()).toEqual(["r-one", "r-two"]);
    expect(next.snapshot.fingerprint).not.toBe(opened.snapshot.fingerprint);
    expect(readSnapshot("s#2")?.fingerprint).toBe(next.snapshot.fingerprint);
    const archived = readFileSync(
      path.join(sessionDir("s#2"), "history", "0", "snapshot.json"),
      "utf8",
    );
    expect(archived).toContain(opened.snapshot.fingerprint);
    removeSession("s");
    removeSession("s#2");
  });

  it("is idempotent: rebasing an already-rebased id returns the same generation", () => {
    open("idem");
    markSession("idem", "conflicted", 0);
    const first = rebaseSession("idem", {
      root,
      rules: [rule("r-one", "new")],
      thresholds: { act: 0.8, flag: 0.5 },
      projectSources: [{ path: "AGENTS.md", sha: "b".repeat(64) }],
      globalSources: [],
    });
    const second = rebaseSession("idem", {
      root,
      rules: [rule("r-one", "new")],
      thresholds: { act: 0.8, flag: 0.5 },
      projectSources: [{ path: "AGENTS.md", sha: "b".repeat(64) }],
      globalSources: [],
    });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") throw new Error("rebase failed");
    expect(first.newSessionId).toBe("idem#2");
    expect(second.newSessionId).toBe("idem#2");
    expect(second.snapshot.generation).toBe(1);
    expect(liveSessionId("idem")).toBe("idem#2");
    expect(readSnapshot("idem")?.sessionId).toBe("idem#2");
    removeSession("idem");
    removeSession("idem#2");
  });

  it("writes each delivered event once: retries and parallel deliveries share the marker", () => {
    open("s");
    const event: AbideEvent = {
      kind: "check",
      at: "now",
      phase: "edit",
      sessionId: "s",
      eventId: "evt-1",
      files: ["a.ts"],
      rules: 1,
      latencyMs: 5,
      verdicts: [],
      blocked: false,
    };
    expect(appendEventOnce(root, "s", 0, "evt-1", event)).toBe(true);
    expect(appendEventOnce(root, "s", 0, "evt-1", event)).toBe(false);
    expect(appendEventOnce(root, "s", 0, "evt-1", event)).toBe(false);
    expect(readEvents(root)).toHaveLength(1);
  });

  it("does not leave a half audit: a failed commit attempt leaves no commit event", () => {
    const opened = open("s");
    // Rules drifted, so the commit is refused before any commit event is written.
    const result = validateCommit(
      {
        sessionId: "s",
        turnId: "p",
        currentFingerprint: "z".repeat(64),
        changedSources: ["AGENTS.md"],
        files: ["a.ts"],
        verdicts: [{ ruleId: "r-one", band: "act", files: ["a.ts"] }],
        judgedAfter: new Map([["a.ts", "x"]]),
        blobNow: () => "x",
      },
      opened.snapshot,
    );
    expect(result.status).toBe("conflict");
    expect(readEvents(root).filter((e) => e.kind === "session-commit")).toHaveLength(0);
    expect(readSessionStatus("s")?.status).not.toBe("committed");
  });

  it("marks the directory owner-only and ephemeral sessions are not registered", () => {
    writeFileSync(path.join(root, "AGENTS.md"), "x");
    const ephemeral = ensureSession({
      sessionId: "short-1",
      root,
      rules: [rule("r")],
      thresholds: { act: 0.8, flag: 0.5 },
      projectSources: [],
      globalSources: [],
      ephemeral: true,
    });
    expect(ephemeral?.snapshot.ephemeral).toBe(true);
    expect(existsSync(path.join(root, ".abide", "sessions"))).toBe(false);
    const mode = statSync(sessionDir("short-1")).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

import { runOnce } from "../src/lib/checkSession.js";

describe("idempotent hook delivery", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abide-once-repo-"));
    home = mkdtempSync(path.join(tmpdir(), "abide-once-home-"));
    process.env.ABIDE_HOME_DIR = home;
  });
  afterEach(() => {
    delete process.env.ABIDE_HOME_DIR;
  });

  it("runs the work once when the same event is delivered again and replays the same output", async () => {
    open("dup");
    let calls = 0;
    const doIt = () =>
      runOnce({
        sessionId: "dup",
        eventId: "evt",
        waitMs: 200,
        measureMs: () => 1,
        work: () => {
          calls += 1;
          return { kind: "block", reason: `ran ${calls}` };
        },
      });
    const first = await doIt();
    const second = await doIt();
    const third = await doIt();
    expect(calls).toBe(1);
    expect(first).toEqual({ kind: "block", reason: "ran 1" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("lets only one of two parallel adapters do the work, in either arrival order", async () => {
    for (const order of ["a-first", "b-first"] as const) {
      const sessionId = `par-${order}`;
      open(sessionId);
      let calls = 0;
      const deliver = (id: string, delayMs: number) =>
        runOnce({
          sessionId,
          eventId: "same",
          waitMs: 500,
          measureMs: () => 1,
          work: () =>
            new Promise((resolve) => {
              calls += 1;
              setTimeout(
                () => resolve({ kind: "notice", systemMessage: `done by ${id}` }),
                delayMs,
              );
            }),
        });
      const [first, second] =
        order === "a-first"
          ? await Promise.all([deliver("a", 100), deliver("b", 10)])
          : await Promise.all([deliver("a", 10), deliver("b", 100)]);
      void first;
      expect(second).toEqual({ kind: "notice", systemMessage: "done by a" });
      expect(calls).toBe(1);
    }
  });

  it("different event ids both run, even when their deliveries interleave", async () => {
    open("two");
    const ran: string[] = [];
    await Promise.all([
      runOnce({
        sessionId: "two",
        eventId: "evt-1",
        waitMs: 200,
        measureMs: () => 1,
        work: async () => {
          ran.push("1-start");
          await new Promise((resolve) => setTimeout(resolve, 30));
          ran.push("1-end");
          return { kind: "silent" };
        },
      }),
      runOnce({
        sessionId: "two",
        eventId: "evt-2",
        waitMs: 200,
        measureMs: () => 1,
        work: () => {
          ran.push("2");
          return { kind: "silent" };
        },
      }),
    ]);
    expect(ran).toContain("1-end");
    expect(ran).toContain("2");
    expect(ran.filter((step) => step === "2")).toHaveLength(1);
  });

  it("releases the claim when the work throws, so a retry can run", async () => {
    open("retry");
    let calls = 0;
    const first = await runOnce({
      sessionId: "retry",
      eventId: "evt",
      waitMs: 100,
      measureMs: () => 1,
      work: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    expect(first).toEqual({ kind: "silent" });
    const second = await runOnce({
      sessionId: "retry",
      eventId: "evt",
      waitMs: 100,
      measureMs: () => 1,
      work: () => {
        calls += 1;
        return { kind: "notice", systemMessage: "recovered" };
      },
    });
    expect(calls).toBe(2);
    expect(second).toEqual({ kind: "notice", systemMessage: "recovered" });
  });
});
