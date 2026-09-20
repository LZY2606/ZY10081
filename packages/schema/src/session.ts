import { z } from "zod";
import { rubricSourceSchema, thresholdsSchema } from "./rubric.js";
import { verdictSchema } from "./verdict.js";

export const CHECK_SESSION_VERSION = 1;

/** A rule frozen into a session. `origin` says which rubric it came from. */
export const sessionRuleSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    source: z.object({ path: z.string(), line: z.number().int().min(1).optional() }),
    scope: z.array(z.string()).optional(),
    when: z.enum(["edit", "turn"]).optional(),
    check: z.unknown(),
    status: z.string(),
    origin: z.enum(["project", "global"]).default("project"),
  })
  .passthrough();
export type SessionRule = z.infer<typeof sessionRuleSchema>;

export const sessionSourceSchema = rubricSourceSchema.extend({
  origin: z.enum(["project", "global"]),
});
export type SessionSource = z.infer<typeof sessionSourceSchema>;

/**
 * The immutable part of a check session: the rule set, its fingerprint, the
 * base commit, the allowed scope, and the file versions known at the start.
 * Hooks append evidence against it; they never edit it and never re-read
 * rules. Paths are repo-relative or "~/..." — no absolute home paths and
 * never credentials or raw secrets, so the snapshot is safe to serialize and
 * restore across processes.
 */
export const checkSessionSnapshotSchema = z.object({
  version: z.literal(CHECK_SESSION_VERSION),
  sessionId: z.string().min(1),
  /** Bumped by an explicit rebase; zero is the session the hooks opened. */
  generation: z.number().int().min(0).default(0),
  /** Repo-relative root spelling: "." or "~/...", never an absolute home path. */
  root: z.string().min(1),
  host: z.string().optional(),
  startedAt: z.string(),
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  baseTree: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  sources: z.array(sessionSourceSchema),
  rules: z.array(sessionRuleSchema),
  thresholds: thresholdsSchema,
  /** Fingerprint over sources, thresholds and the frozen rules. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Paths this session may judge: repo-relative globs. Empty means the repo. */
  scope: z.array(z.string()).default([]),
  /**
   * File versions known at session start or appended with evidence: blob id,
   * or null for a file that did not exist. This is the drift baseline.
   */
  knownFiles: z.record(z.string(), z.string().nullable()),
  ephemeral: z.boolean().default(false),
});
export type CheckSessionSnapshot = z.infer<typeof checkSessionSnapshotSchema>;

/** What drifted when a commit was validated. */
export const sessionConflictSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rules"),
    oldFingerprint: z.string(),
    newFingerprint: z.string(),
    changedSources: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("files"),
    /** Files whose on-disk version is neither the known one nor a judged one. */
    drifted: z.array(z.string()),
  }),
]);
export type SessionConflict = z.infer<typeof sessionConflictSchema>;

/** One verdict a commit validates: enough to name the verdicts a drift invalidates. */
export const verdictRefSchema = z.object({
  ruleId: z.string(),
  band: verdictSchema.shape.band,
  files: z.array(z.string()),
});
export type VerdictRef = z.infer<typeof verdictRefSchema>;

/** Result of validating a session before its verdicts are committed. */
export const sessionValidationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("clean"), currentFingerprint: z.string() }),
  z.object({
    status: z.literal("conflict"),
    conflicts: z.array(sessionConflictSchema).min(1),
    affected: z.array(verdictRefSchema),
  }),
]);
export type SessionValidation = z.infer<typeof sessionValidationSchema>;
