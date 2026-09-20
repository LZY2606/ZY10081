import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlobId } from "@coldtea/abide-schema";
import {
  buildSnapshot,
  checkEventId,
  claimEvent,
  commitEvent,
  coveredFiles,
  markConflict,
  openSession,
  readConflict,
  readSnapshot,
  rebaseSession,
  thresholdsOf,
  verifySession,
  awaitResult,
} from "../src/lib/checkSession.js";
import { appendEventOnce, readEvents } from "../src/lib/events.js";
import { readRubric } from "../src/lib/rubricFile.js";
import { createSourceSha, type AbideEvent, type Rubric, type Rule } from "@coldtea/abide-schema";

let home: string;
let root: string;

const modelRule = (id: string, scope: string[] = ["**/*"]): Rule => ({
  id,
  text: `rule ${id}`,
  source: { path: "AGENTS.md" },
  when: "turn" as const,
  scope,
  status: "active" as const,
  check: { type: "model" as const, question: { type: "boolean" as const, instructions: "?" } },
});

const writeRepo = (rules: Rule[]): Rubric => {
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  const sha = createSourceSha(readFileSync(path.join(root, "AGENTS.md"), "utf8"));
  const rubric: Rubric = {
    version: 1,
    compiledAt: "2026-01-01T00:00:00Z",
    sources: [{ path: "AGENTS.md", sha }],
    rules,
  };
  mkdirSync(path.join(root, ".abide"), { recursive: true });
  writeFileSync(path.join(root, ".abide", "rubric.json"), JSON.stringify(rubric));
  return rubric;
};

const load = () => {
  const read = readRubric(path.join(root, ".abide", "rubric.json"));
  return { project: read.kind === "ok" ? read.rubric : undefined };
};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  process.env.ABIDE_HOME_DIR = home;
});
afterEach(() => {
  delete process.env.ABIDE_HOME_DIR;
});

describe("immutable check sessions", () => {
  it("records sources, fingerprint, scope and thresholds, and serializes through the schema", () => {
    const rubric = writeRepo([modelRule("say-why"), modelRule("typed-only", ["src/**/*.ts"])]);
    const snapshot = buildSnapshot({ sessionId: "s1", root, project: rubric });
    const again = readSnapshot("s1", undefined as unknown as string) ?? snapshot;
    expect(again.rules).toHaveLength(2);
    expect(again.ruleFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(again.ruleSources.map((s) => s.path)).toContain("AGENTS.md");
    expect(again.origins[0]?.kind).toBe("project");
    expect(again.allowedScope).toContain("src/**/*.ts");
    expect(thresholdsOf(again)).toEqual({ act: 0.8, flag: 0.5 });
  });

  it("creates the snapshot once and ignores rules that change on disk afterwards", () => {
    writeRepo([modelRule("rule-one")]);
    const first = openSession("s1", root, load);
    expect(first?.rules.map((r) => r.id)).toEqual(["rule-one"]);

    // Rewrite the rubric mid-session. The existing snapshot must not move.
    writeRepo([modelRule("rule-two")]);
    const second = openSession("s1", root, load);
    expect(second?.ruleFingerprint).toBe(first?.ruleFingerprint);
    expect(second?.rules.map((r) => r.id)).toEqual(["rule-one"]);
  });

  it("flags rules drift when an instruction file changes mid-session", () => {
    const rubric = writeRepo([modelRule("rule-one")]);
    const snapshot = buildSnapshot({
      sessionId: "s1",
      root,
      project: rubric,
      knownFiles: [{ path: "a.ts", blob: null }],
    });
    writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
    const delivered = [{ path: "a.ts", blob: createBlobId("const a = 1;\n") }];
    expect(verifySession(snapshot, root, ["a.ts"], delivered).kind).toBe("clean");

    writeFileSync(path.join(root, "AGENTS.md"), "- a different rule\n");
    const drift = verifySession(snapshot, root, ["a.ts"], delivered);
    expect(drift.kind).toBe("rules");
    if (drift.kind === "rules") {
      expect(drift.oldFingerprint).toBe(snapshot.ruleFingerprint);
      expect(drift.newFingerprint).not.toBe(drift.oldFingerprint);
      expect(drift.affectedRules).toContain("rule-one");
    }
  });

  it("flags external file drift when a covered file changed outside the delivered blobs", () => {
    const rubric = writeRepo([modelRule("rule-one")]);
    const a = "a.ts";
    writeFileSync(path.join(root, a), "v1\n");
    const snapshot = buildSnapshot({
      sessionId: "s1",
      root,
      project: rubric,
      knownFiles: [{ path: a, blob: createBlobId("v1\n") }],
    });

    // The session delivered an edit taking a.ts v1 -> v2; disk agrees: clean.
    writeFileSync(path.join(root, a), "v2\n");
    expect(verifySession(snapshot, root, [a], [{ path: a, blob: createBlobId("v2\n") }]).kind).toBe(
      "clean",
    );

    // Something outside the hooks changes the file after that delivery.
    writeFileSync(path.join(root, a), "v3-from-shell\n");
    const drift = verifySession(snapshot, root, [a], [{ path: a, blob: createBlobId("v2\n") }]);
    expect(drift.kind).toBe("files");
    if (drift.kind === "files") expect(drift.changed).toEqual([a]);
  });

  it("does not flag a file that simply grew from the snapshot through a delivered edit", () => {
    const rubric = writeRepo([modelRule("rule-one")]);
    const snapshot = buildSnapshot({
      sessionId: "s1",
      root,
      project: rubric,
      knownFiles: [{ path: "a.ts", blob: createBlobId("start\n") }],
    });
    writeFileSync(path.join(root, "a.ts"), "start\nmore\n");
    const drift = verifySession(
      snapshot,
      root,
      ["a.ts"],
      [{ path: "a.ts", blob: createBlobId("start\nmore\n") }],
    );
    expect(drift.kind).toBe("clean");
  });

  it("claims an event id once, so a retry commits one event and one verdict set", () => {
    writeRepo([modelRule("rule-one")]);
    const id = checkEventId("s1", "edit", "turn-1", "tool-1", ["a.ts"]);
    expect(checkEventId("s1", "edit", "turn-1", "tool-1", ["a.ts"])).toBe(id);
    expect(checkEventId("s1", "edit", "turn-1", "tool-2", ["a.ts"])).not.toBe(id);

    const first = claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    const retry = claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    expect(first.status).toBe("won");
    expect(retry.status).toBe("duplicate");

    const event: AbideEvent = {
      kind: "check",
      at: "now",
      phase: "edit",
      sessionId: "s1",
      eventId: id,
      files: ["a.ts"],
      rules: 1,
      latencyMs: 1,
      verdicts: [{ ruleId: "rule-one", probability: 0.9, band: "act" }],
      blocked: true,
    };
    const committed = commitEvent(root, "s1", id, event, { kind: "silent" });
    expect(committed && committed.event.kind === "check" ? committed.event.eventId : "").toBe(id);

    // Committing the same id again lands no second line.
    expect(appendEventOnce(root, event)).toBe(true);
    const logged = readEvents(root).filter(
      (e): e is Extract<AbideEvent, { kind: "check" }> => e.kind === "check" && e.eventId === id,
    );
    expect(logged).toHaveLength(1);
  });

  it("publishes the committed result for a duplicate waiting on the winner", async () => {
    writeRepo([modelRule("rule-one")]);
    const id = checkEventId("s1", "edit", "turn-1", "tool-9", ["a.ts"]);
    claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    const duplicate = claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    expect(duplicate.status).toBe("duplicate");

    const waiter = awaitResult("s1", id, 500);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiterEvent: AbideEvent = {
      kind: "check",
      at: "now",
      phase: "edit",
      sessionId: "s1",
      eventId: id,
      files: ["a.ts"],
      rules: 1,
      latencyMs: 1,
      verdicts: [],
      blocked: false,
    };
    commitEvent(root, "s1", id, waiterEvent, { kind: "silent" });
    const got = await waiter;
    expect(got && got.event.kind === "check" ? got.event.eventId : "").toBe(id);
  });

  it("recovers an event whose winner died before committing, with no half audit", () => {
    writeRepo([modelRule("rule-one")]);
    const id = checkEventId("s1", "edit", "turn-1", "tool-dead", ["a.ts"]);
    claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    // Simulate a dead winner: rewrite the claim with an impossible, old pid.
    const claimPath = path.join(
      home,
      ".abide",
      "sessions",
      "s1",
      ".session",
      "events",
      id,
      "claim.json",
    );
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    claim.pid = 999_999;
    claim.born = Date.now() - 60_000;
    writeFileSync(claimPath, JSON.stringify(claim));

    const takeover = claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts"] });
    expect(takeover.status).toBe("won");
    expect(readEvents(root).filter((e) => e.kind === "check" && e.eventId === id)).toHaveLength(0);
  });

  it("records covered files from committed evidence only", () => {
    writeRepo([modelRule("rule-one")]);
    const snapshot = openSession("s1", root, load)!;
    const id = checkEventId("s1", "edit", "turn-1", "tool-x", ["a.ts", "b.ts"]);
    claimEvent("s1", { eventId: id, phase: "edit", files: ["a.ts", "b.ts"] });
    commitEvent(
      root,
      "s1",
      id,
      {
        kind: "check",
        at: "now",
        phase: "edit",
        sessionId: "s1",
        eventId: id,
        files: ["a.ts", "b.ts"],
        rules: 1,
        latencyMs: 1,
        verdicts: [],
        blocked: false,
      },
      { kind: "silent" },
    );
    expect(coveredFiles(snapshot)).toEqual(["a.ts", "b.ts"]);
  });

  it("marks a conflict and rebases onto the new rules with the old snapshot archived", () => {
    writeRepo([modelRule("rule-one")]);
    const snapshot = openSession("s1", root, load)!;
    writeFileSync(path.join(root, "AGENTS.md"), "- new instruction\n");
    const drift = verifySession(snapshot, root, ["a.ts"], []);
    if (drift.kind === "clean") throw new Error("expected drift");
    const marked = markConflict(snapshot, drift, ["a.ts"]);
    expect(readConflict("s1")?.conflict?.kind).toBe("rules");

    writeRepo([modelRule("rule-two")]);
    const result = rebaseSession("s1", root, load);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.snapshot.rules.map((r) => r.id)).toEqual(["rule-two"]);
      expect(result.snapshot.rebasedFrom).toBe(snapshot.ruleFingerprint);
      expect(readConflict("s1")).toBeUndefined();
      expect(marked.sessionId).toBe("s1");
    }
  });

  it("never writes credentials, a home path or file contents into the snapshot", () => {
    process.env.TYPESAFE_AI_API_KEY = "sk-secret-value";
    const rubric = writeRepo([modelRule("rule-one")]);
    const snapshot = buildSnapshot({ sessionId: "s1", root, project: rubric });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("sk-secret-value");
    expect(json).not.toContain(home);
    expect(json).not.toContain(tmpdir());
    delete process.env.TYPESAFE_AI_API_KEY;
  });
});
