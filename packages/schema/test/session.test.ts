import { describe, expect, it } from "vitest";
import {
  checkSessionSnapshotSchema,
  createHookEventId,
  createRulesFingerprint,
  eventSchema,
  hookOutputSchema,
} from "../src/index.js";

const rules = [
  {
    id: "use-type",
    text: "Use type, never interface",
    source: { path: "AGENTS.md" },
    when: "edit",
    check: { type: "model", question: { type: "boolean", instructions: "?" } },
    status: "active",
    origin: "project",
  },
] as const;

const sources = [{ path: "AGENTS.md", sha: "a".repeat(64) }] as const;

describe("rule fingerprints", () => {
  it("is stable for the same compiled view and changes when the rules do", () => {
    const once = createRulesFingerprint({ rules, thresholds: { act: 0.8, flag: 0.5 }, sources });
    const twice = createRulesFingerprint({ rules, thresholds: { act: 0.8, flag: 0.5 }, sources });
    expect(once).toBe(twice);
    expect(once).toMatch(/^[0-9a-f]{64}$/);

    const changedRule = createRulesFingerprint({
      rules: [{ ...rules[0], text: "different text" }],
      thresholds: { act: 0.8, flag: 0.5 },
      sources,
    });
    expect(changedRule).not.toBe(once);

    const changedSource = createRulesFingerprint({
      rules,
      thresholds: { act: 0.8, flag: 0.5 },
      sources: [{ path: "AGENTS.md", sha: "b".repeat(64) }],
    });
    expect(changedSource).not.toBe(once);

    const changedThresholds = createRulesFingerprint({
      rules,
      thresholds: { act: 0.9, flag: 0.4 },
      sources,
    });
    expect(changedThresholds).not.toBe(once);
  });

  it("is order-dependent, since a rubric is a compiled list", () => {
    const first = rules[0];
    if (first === undefined) throw new Error("test rule missing");
    const one = { ...first, id: "other-rule" };
    const two = { ...first };
    const a = createRulesFingerprint({
      rules: [one, two],
      thresholds: { act: 0.8, flag: 0.5 },
      sources,
    });
    const b = createRulesFingerprint({
      rules: [two, one],
      thresholds: { act: 0.8, flag: 0.5 },
      sources,
    });
    expect(a).not.toBe(b);
  });
});

describe("hook event ids", () => {
  it("makes a retried delivery identical and a different event distinct", () => {
    const first = createHookEventId({ sessionId: "s", event: "PostToolUse", turnId: "p" });
    const retry = createHookEventId({ sessionId: "s", event: "PostToolUse", turnId: "p" });
    expect(first).toBe(retry);
    expect(
      createHookEventId({ sessionId: "s", event: "PostToolUse", turnId: "p", toolUseId: "t1" }),
    ).not.toBe(
      createHookEventId({ sessionId: "s", event: "PostToolUse", turnId: "p", toolUseId: "t2" }),
    );
    expect(createHookEventId({ sessionId: "s", event: "Stop", turnId: "p", attempt: 0 })).not.toBe(
      createHookEventId({ sessionId: "s", event: "Stop", turnId: "p", attempt: 1 }),
    );
  });
});

describe("check session snapshots", () => {
  const snapshot = {
    version: 1 as const,
    sessionId: "s",
    root: ".",
    startedAt: "now",
    baseCommit: null,
    baseTree: null,
    sources: [{ path: "AGENTS.md", sha: "a".repeat(64), origin: "project" as const }],
    rules: [...rules],
    thresholds: { act: 0.8, flag: 0.5 },
    fingerprint: createRulesFingerprint({ rules, thresholds: { act: 0.8, flag: 0.5 }, sources }),
    scope: [],
    knownFiles: { "AGENTS.md": "a".repeat(40) },
  };

  it("round-trips a serialized snapshot after a restart", () => {
    const parsed = checkSessionSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.sessionId).toBe("s");
    expect(parsed.rules[0]?.id).toBe("use-type");
    expect(parsed.knownFiles["AGENTS.md"]).toHaveLength(40);
  });

  it("defaults generation, scope and the ephemeral flag for old serializers", () => {
    const {
      generation,
      scope,
      ephemeral,
      rules: parsedRules,
    } = checkSessionSnapshotSchema.parse({
      version: 1,
      sessionId: "s",
      root: "~/work/repo",
      startedAt: "now",
      baseCommit: null,
      baseTree: null,
      sources: [],
      rules: [],
      thresholds: { act: 0.8, flag: 0.5 },
      knownFiles: {},
    });
    expect(generation).toBe(0);
    expect(scope).toEqual([]);
    expect(ephemeral).toBe(false);
    expect(parsedRules).toEqual([]);
  });
});

describe("session audit events", () => {
  it("accepts a session-conflict event naming both fingerprints and affected verdicts", () => {
    const parsed = eventSchema.parse({
      kind: "session-conflict",
      at: "now",
      sessionId: "s",
      generation: 0,
      eventId: "e1",
      conflicts: [
        {
          kind: "rules",
          oldFingerprint: "a".repeat(64),
          newFingerprint: "b".repeat(64),
          changedSources: ["AGENTS.md"],
        },
        { kind: "files", drifted: ["src/a.ts"] },
      ],
      affected: [{ ruleId: "use-type", band: "act", files: ["src/a.ts"] }],
    });
    expect(parsed.kind).toBe("session-conflict");
    if (parsed.kind === "session-conflict") {
      expect(parsed.conflicts).toHaveLength(2);
      expect(parsed.affected[0]?.ruleId).toBe("use-type");
    }
  });

  it("accepts a session-commit event with covered files and a fingerprint", () => {
    const parsed = eventSchema.parse({
      kind: "session-commit",
      at: "now",
      sessionId: "s",
      generation: 2,
      eventId: "e2",
      fingerprint: "a".repeat(64),
      files: ["src/a.ts", "src/b.ts"],
      verdicts: 3,
    });
    expect(parsed.kind).toBe("session-commit");
  });
});

describe("published hook results", () => {
  it("parses every hook output shape a retried delivery may replay", () => {
    expect(hookOutputSchema.parse({ kind: "silent" })).toEqual({ kind: "silent" });
    expect(hookOutputSchema.parse({ kind: "block", reason: "no" }).kind).toBe("block");
    expect(hookOutputSchema.safeParse({ kind: "explode" }).success).toBe(false);
  });
});
