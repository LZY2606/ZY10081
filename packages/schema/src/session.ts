import { createHash } from "node:crypto";
import { z } from "zod";
import { ruleSchema } from "./rubric.js";

export const SESSION_SNAPSHOT_VERSION = 1;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A compiled rubric the snapshot's rules were taken from. */
export const snapshotOriginSchema = z.object({
  /** "project" or "global". */
  kind: z.enum(["project", "global"]),
  /** Repo-relative path, or "~/..." for a file in the home directory. */
  path: z.string().min(1),
  /** sha256 hex of the rubric file's bytes at session start. */
  sha: sha256,
});
export type SnapshotOrigin = z.infer<typeof snapshotOriginSchema>;

const gitOid = z.string().regex(/^[0-9a-f]{40,64}$/);

/** A file version the session was based on: a git blob id, or null for a file absent then. */
export const knownFileSchema = z.object({
  /** Repo-relative posix path. */
  path: z.string().min(1),
  blob: z.string().nullable(),
});
export type KnownFile = z.infer<typeof knownFileSchema>;

/**
 * The immutable view a check session runs against. Written once at session
 * start and never rewritten. Hooks append evidence, but the rules, base commit,
 * scope and known file versions stay exactly as they were here.
 */
export const checkSessionSnapshotSchema = z.object({
  version: z.literal(SESSION_SNAPSHOT_VERSION),
  /** Host session id this snapshot serves. */
  sessionId: z.string().min(1),
  /** Stable hash of the repo this session belongs to; never an absolute path. */
  repoKey: z.string().regex(/^[0-9a-f]{16,64}$/),
  createdAt: z.string(),
  /** Compiled rules as they were at session start, tagged with their origin. */
  rules: z.array(
    ruleSchema.extend({
      origin: z.enum(["project", "global"]),
    }),
  ),
  act: z.number().min(0).max(1),
  flag: z.number().min(0).max(1),
  /** Instruction and rubric files, with the bytes the rules were compiled from. */
  ruleSources: z.array(
    z.object({
      path: z.string().min(1),
      sha: sha256,
    }),
  ),
  origins: z.array(snapshotOriginSchema),
  /** Fingerprint of the compiled rule set; what drift is measured against. */
  ruleFingerprint: sha256,
  /** Globs the session is allowed to judge. ["**\/*"] when no rule narrows scope. */
  allowedScope: z.array(z.string().min(1)).min(1),
  base: z.object({
    kind: z.enum(["git", "files"]),
    /** HEAD commit at session start for a git repository. */
    head: gitOid.optional(),
    /** Working-tree tree object at session start, when git could say. */
    tree: gitOid.nullable().optional(),
  }),
  knownFiles: z.array(knownFileSchema),
  /** Snapshot this one explicitly rebased from. */
  rebasedFrom: z.string().optional(),
  conflict: z
    .object({
      kind: z.enum(["rules", "files"]),
      oldFingerprint: sha256,
      newFingerprint: sha256,
      at: z.string(),
      /** Rule ids whose verdicts were withheld because the view had drifted. */
      affectedRules: z.array(z.string()),
      files: z.array(z.string()),
    })
    .optional(),
});
export type CheckSessionSnapshot = z.infer<typeof checkSessionSnapshotSchema>;

export type SnapshotRule = CheckSessionSnapshot["rules"][number];

/**
 * Fingerprint material for a compiled rule set: the rules as compiled plus the
 * bytes of the instruction and rubric files they came from. Editing an
 * instruction file without recompiling still moves the fingerprint, so a
 * session that started on the old words can tell.
 */
export const ruleFingerprintOf = (
  rules: readonly z.infer<typeof ruleSchema>[],
  sources: readonly { path: string; sha?: string }[] = [],
): string => {
  const rulePart = rules.map(({ id, status, when, scope, check, text }) => ({
    id,
    status,
    when,
    scope,
    check,
    text,
  }));
  const byPath = new Map(sources.map((source) => [source.path, source.sha ?? ""]));
  const sourcePart = [...byPath.entries()]
    .map(([file, sha]) => `${file}:${sha}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(JSON.stringify(rulePart)).update(sourcePart).digest("hex");
};

/** One delivered host event, exactly once, with the verdict set it produced. */
export const sessionEventRecordSchema = z.object({
  eventId: z.string().min(1),
  at: z.string(),
  /** One of the check-session phases; "turn-start" carries no verdict. */
  phase: z.enum(["edit", "turn", "turn-start"]),
  /** Repo-relative files this event judged or claimed. */
  files: z.array(z.string()),
  /** Blob ids reachable from the delivered edits, so commit can detect outside drift. */
  afterBlobs: z.array(knownFileSchema).optional(),
});
export type SessionEventRecord = z.infer<typeof sessionEventRecordSchema>;
