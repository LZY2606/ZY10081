import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import {
  checkSessionSnapshotSchema,
  createBlobId,
  ruleFingerprintOf,
  type AbideEvent,
  type CheckSessionSnapshot,
  type HookOutput,
  type KnownFile,
  type Rubric,
  type SnapshotRule,
  type Thresholds,
} from "@coldtea/abide-schema";
import { globalRubricPath, homeDir, rubricPath, sessionsDir, toSourcePath } from "./paths.js";
import { hashFile } from "./sources.js";
import { mergeRules, readRubric } from "./rubricFile.js";
import { readRegularFile } from "./regularFile.js";
import { appendEventOnce } from "./events.js";

/**
 * Immutable check sessions.
 *
 * A snapshot is written once, when a session starts, naming the rules, their
 * fingerprint, the base commit, the scope they cover and the file versions in
 * view then. Hooks append evidence by event id but never re-read the rules.
 * Before a verdict is committed the sources and files are checked against the
 * snapshot; a session that drifted is refused, naming both fingerprints and
 * the verdicts affected, until the user explicitly rebases.
 */

const DEFAULT_THRESHOLDS: Thresholds = { act: 0.8, flag: 0.5 };

const safe = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, "_");

export const sessionDir = (sessionId: string): string => path.join(sessionsDir(), safe(sessionId));

const sessionStateDir = (dir: string): string => path.join(dir, ".session");
const snapshotFile = (dir: string): string => path.join(sessionStateDir(dir), "snapshot.json");
export const conflictFilePath = (dir: string): string =>
  path.join(sessionStateDir(dir), "conflict.json");
const eventDir = (dir: string, eventId: string): string =>
  path.join(sessionStateDir(dir), "events", safe(eventId));
const claimFile = (dir: string, eventId: string): string =>
  path.join(eventDir(dir, eventId), "claim.json");
const resultFile = (dir: string, eventId: string): string =>
  path.join(eventDir(dir, eventId), "result.json");

/** Stable key for a repo on this machine, without storing its absolute path. */
export const repoKeyOf = (root: string): string => {
  let resolved = path.resolve(root);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A not-yet-existing directory keeps its resolved spelling.
  }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 32);
};

export const thresholdsOf = (snapshot: CheckSessionSnapshot): Thresholds => ({
  act: snapshot.act,
  flag: snapshot.flag,
});

const writePrivate = (file: string, contents: string, flag: "w" | "wx" = "w"): boolean => {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { flag, mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const resolveFromRoot = (root: string, sourcePath: string): string =>
  sourcePath.startsWith("~")
    ? path.join(homeDir(), sourcePath.slice(2))
    : path.resolve(root, sourcePath);

const shaOf = (absolute: string): string | undefined => hashFile(absolute);

/** Fingerprint of the rules as the tree holds them now, over sources and rubrics. */
const currentFingerprint = (
  root: string,
  project: Rubric | undefined,
  global: Rubric | undefined,
): { fingerprint: string; rules: SnapshotRule[] } => {
  const rules = mergeRules(project, global);
  const sources = new Map<string, string>();
  for (const rubric of [
    { value: project, file: rubricPath(root) },
    { value: global, file: globalRubricPath() },
  ]) {
    const rubricSha = shaOf(rubric.file);
    if (rubricSha !== undefined) sources.set(toSourcePath(root, rubric.file), rubricSha);
    if (rubric.value === undefined) continue;
    for (const source of rubric.value.sources) {
      const absolute = resolveFromRoot(root, source.path);
      const onDisk = shaOf(absolute);
      if (onDisk !== undefined) sources.set(toSourcePath(root, absolute), onDisk);
    }
  }
  return {
    fingerprint: ruleFingerprintOf(
      rules,
      [...sources].map(([file, sha]) => ({ path: file, sha })),
    ),
    rules,
  };
};

const ruleFilesOf = (
  project: Rubric | undefined,
  global: Rubric | undefined,
  root: string,
): { path: string; sha: string }[] => {
  const files = new Map<string, string>();
  for (const rubric of [project, global]) {
    if (rubric === undefined) continue;
    for (const source of rubric.sources) {
      // Hash the bytes as they are now, not the sha the rubric recorded: a
      // snapshot is a view of the working tree at session start.
      const canonical = toSourcePath(root, resolveFromRoot(root, source.path));
      const onDisk = shaOf(resolveFromRoot(root, source.path));
      if (onDisk !== undefined) files.set(canonical, onDisk);
    }
  }
  return [...files.entries()].map(([file, sha]) => ({ path: file, sha }));
};

export type CreateSessionInput = {
  sessionId: string;
  root: string;
  project?: Rubric;
  global?: Rubric;
  /** HEAD commit and working-tree tree for a git repo; absent means the file-based mode. */
  head?: string;
  tree?: string | null;
  /** File versions known at session start: repo-relative path -> blob id, null if absent. */
  knownFiles?: KnownFile[];
  createdAt?: string;
  rebasedFrom?: string;
};

/**
 * Builds a snapshot from already-loaded rubrics. The caller reads rules at
 * most once, on creation; every later check in the session uses the snapshot.
 */
export const buildSnapshot = (input: CreateSessionInput): CheckSessionSnapshot => {
  const { project, global, root } = input;
  const rules = mergeRules(project, global);
  const thresholds = project?.thresholds ?? global?.thresholds ?? DEFAULT_THRESHOLDS;
  const origins = [
    ...(project ? [{ kind: "project" as const, file: rubricPath(root) }] : []),
    ...(global ? [{ kind: "global" as const, file: globalRubricPath() }] : []),
  ]
    .map((o) => ({ kind: o.kind, path: toSourcePath(root, o.file), sha: shaOf(o.file) }))
    .filter(
      (o): o is { kind: "project" | "global"; path: string; sha: string } => o.sha !== undefined,
    );
  const scopes = new Set<string>();
  for (const rule of rules) for (const glob of rule.scope ?? ["**/*"]) scopes.add(glob);
  const ruleSources = ruleFilesOf(project, global, root);
  const { fingerprint } = currentFingerprint(root, project, global);
  return {
    version: 1,
    sessionId: input.sessionId,
    repoKey: repoKeyOf(root),
    createdAt: input.createdAt ?? new Date().toISOString(),
    rules,
    act: thresholds.act,
    flag: thresholds.flag,
    ruleSources,
    origins,
    ruleFingerprint: fingerprint,
    allowedScope: [...scopes],
    base:
      input.head !== undefined
        ? {
            kind: "git",
            head: input.head,
            ...(input.tree === undefined ? {} : { tree: input.tree }),
          }
        : { kind: "files" },
    knownFiles: input.knownFiles ?? [],
    ...(input.rebasedFrom === undefined ? {} : { rebasedFrom: input.rebasedFrom }),
  };
};

const parseSnapshot = (raw: unknown): CheckSessionSnapshot | undefined => {
  const parsed = checkSessionSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

/** The current snapshot for a session on this repo, or none it can use. */
export const readSnapshot = (sessionId: string, root: string): CheckSessionSnapshot | undefined => {
  const snapshot = parseSnapshot(readJson(snapshotFile(sessionDir(sessionId))));
  if (snapshot === undefined || snapshot.repoKey !== repoKeyOf(root)) return undefined;
  return snapshot;
};

export type LoadedInput = {
  project?: Rubric;
  global?: Rubric;
  knownFiles?: KnownFile[];
  head?: string;
  tree?: string | null;
};

/**
 * Opens a session's snapshot, creating it the first time the session checks.
 * Rules are read from disk at most once, on creation. An existing snapshot is
 * returned exactly as written, even if the rubric changed underneath it.
 */
export const openSession = (
  sessionId: string,
  root: string,
  load: () => LoadedInput,
): CheckSessionSnapshot | undefined => {
  const existing = readSnapshot(sessionId, root);
  if (existing !== undefined) return existing;
  const loaded = load();
  if (loaded.project === undefined && loaded.global === undefined) return undefined;
  const snapshot = buildSnapshot({ sessionId, root, ...loaded });
  if (writePrivate(snapshotFile(sessionDir(sessionId)), JSON.stringify(snapshot, null, 2), "wx")) {
    return snapshot;
  }
  // A parallel hook or a second adapter created it first: use theirs.
  return readSnapshot(sessionId, root);
};

/** A session that lives for one CLI invocation: loaded rules, nothing written. */
export const ephemeralSession = (
  root: string,
  project: Rubric | undefined,
  global: Rubric | undefined,
): CheckSessionSnapshot =>
  buildSnapshot({
    sessionId: `short-${createHash("sha256")
      .update(`${root}\0${Date.now()}\0${Math.random()}`)
      .digest("hex")
      .slice(0, 12)}`,
    root,
    project,
    global,
  });

/** Rule ids whose scope reaches at least one of the files. */
export const rulesCovering = (
  rules: readonly SnapshotRule[],
  files: readonly string[],
): string[] => {
  const ids = new Set<string>();
  for (const rule of rules) {
    const globs = rule.scope ?? ["**/*"];
    if (files.some((file) => globs.some((glob) => picomatch(glob, { dot: true })(file)))) {
      ids.add(rule.id);
    }
  }
  return [...ids];
};

export type SessionDrift =
  | { kind: "clean" }
  | {
      kind: "rules";
      oldFingerprint: string;
      newFingerprint: string;
      changed: string[];
      affectedRules: string[];
    }
  | {
      kind: "files";
      oldFingerprint: string;
      newFingerprint: string;
      changed: string[];
      affectedRules: string[];
    };

const blobOf = (absolute: string): string | null => {
  const bytes = readRegularFile(absolute);
  return bytes === undefined ? null : createBlobId(bytes);
};

/** Instruction and rubric bytes still match those the snapshot was built on. */
export const verifyRules = (
  snapshot: CheckSessionSnapshot,
  root: string,
  files: readonly string[],
): SessionDrift => {
  const changedSources: string[] = [];
  for (const source of snapshot.ruleSources) {
    if (shaOf(resolveFromRoot(root, source.path)) !== source.sha) changedSources.push(source.path);
  }
  for (const origin of snapshot.origins) {
    const file = origin.kind === "project" ? rubricPath(root) : globalRubricPath();
    if (shaOf(file) !== origin.sha && !changedSources.includes(origin.path)) {
      changedSources.push(origin.path);
    }
  }
  if (changedSources.length === 0) return { kind: "clean" };
  const project = readRubric(rubricPath(root));
  const global = readRubric(globalRubricPath());
  const current = currentFingerprint(
    root,
    project.kind === "ok" ? project.rubric : undefined,
    global.kind === "ok" ? global.rubric : undefined,
  );
  return {
    kind: "rules",
    oldFingerprint: snapshot.ruleFingerprint,
    newFingerprint: current.fingerprint,
    changed: changedSources,
    affectedRules: rulesCovering(snapshot.rules, files),
  };
};

/** Every delivered file is still at a version the session's edits account for. */
export const verifyFiles = (
  snapshot: CheckSessionSnapshot,
  root: string,
  files: readonly string[],
  afterBlobs: readonly KnownFile[],
): SessionDrift => {
  const delivered = new Map(afterBlobs.map((file) => [file.path, file.blob]));
  const known = new Map(snapshot.knownFiles.map((file) => [file.path, file.blob]));
  const changedFiles: string[] = [];
  for (const rel of files) {
    const now = blobOf(path.join(root, rel));
    const expected = delivered.get(rel);
    if (expected !== undefined) {
      if (expected !== now) changedFiles.push(rel);
      continue;
    }
    if (now !== (known.get(rel) ?? null)) changedFiles.push(rel);
  }
  if (changedFiles.length === 0) return { kind: "clean" };
  return {
    kind: "files",
    oldFingerprint: snapshot.ruleFingerprint,
    newFingerprint: snapshot.ruleFingerprint,
    changed: changedFiles,
    affectedRules: rulesCovering(snapshot.rules, changedFiles),
  };
};

/**
 * Rules and (for an edit delivery) the files a verdict is about to commit.
 * A turn check sources its change from the turn-start baseline by design, so
 * it asks verifyRules only; an edit check also proves the file was not
 * rewritten outside the delivered edit.
 */
export const verifySession = (
  snapshot: CheckSessionSnapshot,
  root: string,
  files: readonly string[],
  afterBlobs: readonly KnownFile[],
): SessionDrift => {
  const rules = verifyRules(snapshot, root, files);
  if (rules.kind !== "clean") return rules;
  return verifyFiles(snapshot, root, files, afterBlobs);
};

/** Marks a session as drifted; the report and the next hook show it until rebase. */
export const markConflict = (
  snapshot: CheckSessionSnapshot,
  drift: Extract<SessionDrift, { kind: "rules" | "files" }>,
  files: readonly string[],
): CheckSessionSnapshot => {
  const withConflict: CheckSessionSnapshot = {
    ...snapshot,
    conflict: {
      kind: drift.kind,
      oldFingerprint: drift.oldFingerprint,
      newFingerprint: drift.newFingerprint,
      at: new Date().toISOString(),
      affectedRules: drift.affectedRules,
      files: drift.kind === "files" ? drift.changed : [...new Set(files)],
    },
  };
  writePrivate(
    conflictFilePath(sessionDir(snapshot.sessionId)),
    JSON.stringify(withConflict, null, 2),
  );
  return withConflict;
};

export const readConflict = (sessionId: string): CheckSessionSnapshot | undefined =>
  readJson(conflictFilePath(sessionDir(sessionId)));

/**
 * Event id for a delivered hook. Same session and event id retried — by a
 * hook retry, a duplicate delivery, or two adapters at once — claims once.
 */
export const checkEventId = (
  sessionId: string,
  phase: "edit" | "turn",
  turnId: string | undefined,
  toolUseId: string | undefined,
  files: readonly string[],
  stopNonce?: string | number,
): string => {
  const turn = safe(turnId ?? "turn");
  if (phase === "edit") {
    const delivery = toolUseId ?? files.map((f) => `${f}:${f.length}`).join("|");
    return createHash("sha256")
      .update(`edit\0${sessionId}\0${turn}\0${delivery}`)
      .digest("hex")
      .slice(0, 24);
  }
  // Each Stop delivery in a repair round is distinct: the turn id plus the
  // delivery number. A plain retry of the same delivery keeps the same id.
  return createHash("sha256")
    .update(`turn\0${sessionId}\0${turn}\0${stopNonce ?? 0}`)
    .digest("hex")
    .slice(0, 24);
};

type Claim = {
  eventId: string;
  at: string;
  phase: "edit" | "turn" | "turn-start";
  files: string[];
  afterBlobs?: KnownFile[];
  pid: number;
  born: number;
};

/** A claim older than this, with no result and a dead pid, is taken over. */
const STALE_CLAIM_MS = Number(process.env.ABIDE_STALE_CLAIM_MS ?? 45_000);

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type EventClaim =
  { status: "won" } | { status: "duplicate"; result: CommittedResult | undefined; stale: boolean };

export type CommittedResult = { event: AbideEvent; output: HookOutput };

/**
 * Claims a delivered event for this process. The winner runs the check once
 * and commits. A retry or a second adapter for the same event id waits for the
 * winner's result instead of running another check.
 */
export const claimEvent = (
  sessionId: string,
  record: Omit<import("@coldtea/abide-schema").SessionEventRecord, "at"> & { at?: string },
): EventClaim => {
  const dir = sessionDir(sessionId);
  const eventId = record.eventId;
  const mine: Claim = {
    eventId,
    at: record.at ?? new Date().toISOString(),
    phase: record.phase,
    files: record.files,
    ...(record.afterBlobs === undefined ? {} : { afterBlobs: record.afterBlobs }),
    pid: process.pid,
    born: Date.now(),
  };
  if (writePrivate(claimFile(dir, eventId), JSON.stringify(mine), "wx")) return { status: "won" };

  const theirs = readJson<Claim>(claimFile(dir, eventId));
  const done = readResult(sessionId, eventId);
  if (done !== undefined) return { status: "duplicate", result: done, stale: false };
  if (theirs !== undefined && !pidAlive(theirs.pid) && Date.now() - theirs.born > STALE_CLAIM_MS) {
    // The winner died before committing: take over rather than lose the event.
    if (writePrivate(claimFile(dir, eventId), JSON.stringify(mine), "w")) {
      return { status: "won" };
    }
  }
  return {
    status: "duplicate",
    result: undefined,
    stale: theirs !== undefined && !pidAlive(theirs.pid),
  };
};

const readResult = (sessionId: string, eventId: string): CommittedResult | undefined => {
  const raw = readJson<CommittedResult>(resultFile(sessionDir(sessionId), eventId));
  if (raw === undefined) return undefined;
  return typeof raw === "object" && raw !== null && "event" in raw && "output" in raw
    ? raw
    : undefined;
};

/** Waits for the winner to commit; resolves undefined if it never does in time. */
export const awaitResult = async (
  sessionId: string,
  eventId: string,
  timeoutMs: number,
): Promise<CommittedResult | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = readResult(sessionId, eventId);
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Commits exactly once: the event is appended to the audit, and only then is
 * the result published for duplicates. If the append itself fails, no result
 * is written, so a retry or a restarted process takes the event over and the
 * audit never holds half of a verdict.
 */
export const commitEvent = (
  root: string,
  sessionId: string,
  eventId: string,
  event: AbideEvent,
  output: HookOutput,
): CommittedResult | undefined => {
  if (!appendEventOnce(root, event)) return undefined;
  const result: CommittedResult = { event, output };
  appendEvidence(sessionId, eventId, event);
  writePrivate(resultFile(sessionDir(sessionId), eventId), JSON.stringify(result));
  return result;
};

/** One evidence record per committed event, naming what the verdict covered. */
const appendEvidence = (sessionId: string, eventId: string, event: AbideEvent): void => {
  const files = "files" in event && Array.isArray(event.files) ? event.files : [];
  const dir = path.join(sessionDir(sessionId), ".session", "evidence");
  writePrivate(
    path.join(dir, `${safe(eventId)}.json`),
    JSON.stringify({ eventId, at: event.at, files }, null, 2),
  );
};

/** Files this session has committed verdicts about. */
export const coveredFiles = (snapshot: CheckSessionSnapshot): string[] => {
  const dir = path.join(sessionDir(snapshot.sessionId), ".session", "evidence");
  const files = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const record = readJson<{ files?: unknown }>(path.join(dir, name));
    if (record && Array.isArray(record.files)) {
      for (const file of record.files) if (typeof file === "string") files.add(file);
    }
  }
  return [...files].sort();
};

/** Current snapshot with any conflict overlay, for reporting. */
export const effectiveSnapshot = (sessionId: string): CheckSessionSnapshot | undefined =>
  readConflict(sessionId) ??
  (readJson(snapshotFile(sessionDir(sessionId))) as CheckSessionSnapshot | undefined);

export type RebaseResult =
  { kind: "ok"; snapshot: CheckSessionSnapshot } | { kind: "missing" } | { kind: "no-rules" };

/**
 * Starts a fresh session view on the rules and tree as they stand now,
 * keeping the same host session id. The old snapshot is archived, not
 * rewritten, so a conflicted verdict remains explainable.
 */
export const rebaseSession = (
  sessionId: string,
  root: string,
  load: () => LoadedInput,
): RebaseResult => {
  const previous = readSnapshot(sessionId, root);
  if (previous === undefined) return { kind: "missing" };
  const loaded = load();
  if (loaded.project === undefined && loaded.global === undefined) return { kind: "no-rules" };

  const dir = sessionDir(sessionId);
  const archiveDir = path.join(sessionStateDir(dir), "history");
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const stamp = previous.ruleFingerprint.slice(0, 10);
  renameSync(
    snapshotFile(dir),
    path.join(archiveDir, `snapshot-${previous.createdAt.replace(/[:.]/g, "-")}-${stamp}.json`),
  );
  const snapshot = buildSnapshot({
    sessionId,
    root,
    ...loaded,
    rebasedFrom: previous.ruleFingerprint,
  });
  if (!writePrivate(snapshotFile(dir), JSON.stringify(snapshot, null, 2))) {
    return { kind: "missing" };
  }
  try {
    rmSync(conflictFilePath(dir), { force: true });
  } catch {
    // No conflict file: nothing to clear.
  }
  return { kind: "ok", snapshot };
};

/** Lists check sessions on this machine, newest first; the report reads this. */
export const listSessions = (): CheckSessionSnapshot[] => {
  let names: string[];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const snapshots: CheckSessionSnapshot[] = [];
  for (const name of names) {
    const snapshot = effectiveSnapshot(path.basename(name));
    const parsed = snapshot ? checkSessionSnapshotSchema.safeParse(snapshot) : undefined;
    if (parsed?.success) snapshots.push(parsed.data);
  }
  return snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};
