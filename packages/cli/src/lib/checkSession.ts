import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  checkSessionSnapshotSchema,
  createBlobId,
  createRulesFingerprint,
  hookOutputSchema,
  type CheckSessionSnapshot,
  type HookOutput,
  type Rule,
  type SessionConflict,
  type RubricSource,
  type SessionRule,
  type SessionSource,
  type SessionValidation,
  type Thresholds,
  type VerdictRef,
} from "@coldtea/abide-schema";
import { blobIdsAt, isGitRepo } from "./git.js";
import { NO_PROMPT_TURN } from "./session.js";
import type { MergedRule } from "./rubricFile.js";
import { resolveSourcePath, sessionsDir, abideDir } from "./paths.js";
import { readRegularFile, readRegularText } from "./regularFile.js";
import { hashFile } from "./sources.js";

/**
 * Immutable check sessions. A snapshot is written once at session start and
 * never rewritten: every hook reads its rules from it, appends evidence
 * against it, and commits only after proving the rule set and the judged
 * files have not moved underneath it. All on-disk files are owner-only, hold
 * no credentials, no absolute home paths and no raw file contents.
 */

const safe = (part: string): string => part.replace(/[^A-Za-z0-9_@=-]/g, "_");

export const sessionDir = (sessionId: string): string => path.join(sessionsDir(), safe(sessionId));

const snapshotFile = (dir: string): string => path.join(dir, "snapshot.json");
const statusFile = (dir: string): string => path.join(dir, "status.json");
const claimsDir = (dir: string, generation: number): string =>
  path.join(dir, "gen", String(generation), "claims");
const resultsDir = (dir: string, generation: number): string =>
  path.join(dir, "gen", String(generation), "results");
const markersDir = (dir: string, generation: number): string =>
  path.join(dir, "gen", String(generation), "events");

export type SessionStatus = "active" | "conflicted" | "committed";

type StatusRecord = { status: SessionStatus; generation: number; updatedAt: string };

const statusSchemaShape = (value: unknown): StatusRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const status = rec.status;
  if (status !== "active" && status !== "conflicted" && status !== "committed") return undefined;
  if (typeof rec.generation !== "number" || typeof rec.updatedAt !== "string") return undefined;
  return { status, generation: rec.generation, updatedAt: rec.updatedAt };
};

const writePrivate = (file: string, contents: string, flag: "w" | "wx" = "w"): boolean => {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { flag, mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

const createOnce = (file: string, contents: string): boolean => writePrivate(file, contents, "wx");

/** One-line append-created registry, so a session is discoverable from a repo. */
export const registerSession = (root: string, sessionId: string): void => {
  try {
    mkdirSync(abideDir(root), { recursive: true });
    writeFileSync(path.join(abideDir(root), "sessions"), `${sessionId}\n`, {
      flag: "a",
      mode: 0o600,
    });
  } catch {
    // discovery is best effort
  }
};

export const repoSessions = (root: string): string[] => {
  try {
    return readFileSync(path.join(abideDir(root), "sessions"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

/** Serialized root: a "~/..." spelling under the home directory, else "." for a machine root. */
const rootSpelling = (root: string): string => {
  const fromHome = path.relative(homedir(), root);
  if (fromHome !== "" && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
    return `~/${fromHome.split(path.sep).join("/")}`;
  }
  return ".";
};

const sessionSources = (
  project: readonly RubricSource[],
  global: readonly RubricSource[],
): SessionSource[] => [
  ...project.map((source) => ({ ...source, origin: "project" as const })),
  ...global.map((source) => ({ ...source, origin: "global" as const })),
];

const frozenRules = (rules: readonly MergedRule[]): SessionRule[] =>
  rules.map((rule) => ({
    id: rule.id,
    text: rule.text,
    source: rule.source,
    ...(rule.scope === undefined ? {} : { scope: rule.scope }),
    ...(rule.when === undefined ? {} : { when: rule.when }),
    check: rule.check,
    status: rule.status,
    origin: rule.origin,
  }));

/** Project sources scope to the repo; global sources scope to the whole tree. */
export const sessionScopeGlobs = (
  projectSources: readonly RubricSource[],
  globalSources: readonly RubricSource[],
): string[] => {
  const globs = new Set<string>();
  for (const source of projectSources) {
    if (source.scope !== undefined) globs.add(source.scope);
  }
  if (globalSources.length > 0) globs.add("**/*");
  return [...globs];
};

export type OpenSessionInput = {
  sessionId: string;
  root: string;
  host?: string;
  rules: readonly MergedRule[];
  thresholds: Thresholds;
  projectSources: readonly RubricSource[];
  globalSources: readonly RubricSource[];
  /** Turn-start already snapshotted the working tree; reuse it for the baseline. */
  baseTree?: string | null;
  baseCommit?: string | null;
  /** A check command opens an internal short session that must not be reported. */
  ephemeral?: boolean;
  startedAt?: string;
};

export type OpenedSession = {
  snapshot: CheckSessionSnapshot;
  rules: Rule[];
  dir: string;
  created: boolean;
};

const parseSnapshot = (raw: string): CheckSessionSnapshot | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = checkSessionSnapshotSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
};

const gitHead = (root: string): string | null => {
  if (!isGitRepo(root)) return null;
  const text = gitStdout(root, ["rev-parse", "HEAD"]);
  return text !== undefined && /^[0-9a-f]{40,64}$/.test(text) ? text : null;
};

const gitStdout = (root: string, args: string[]): string | undefined => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const knownFilesAt = (root: string, tree: string | null): Record<string, string | null> => {
  if (tree === null) return {};
  const ids = blobIdsAt(root, tree, ["."], 5_000);
  if (ids === undefined) return {};
  const known: Record<string, string | null> = {};
  for (const [file, blob] of ids) {
    if (!file.includes("\u0000")) known[file] = blob;
  }
  return known;
};

const writeStatus = (dir: string, status: SessionStatus, generation: number): void => {
  const record: StatusRecord = { status, generation, updatedAt: new Date().toISOString() };
  writePrivate(statusFile(dir), JSON.stringify(record));
};

/**
 * Opens the session against the rules as they stand now, or restores the
 * frozen one from disk. Two hooks racing to open both end up with the same
 * snapshot: the writer wins the `wx`, the reader parses what it wrote.
 */
export const ensureSession = (input: OpenSessionInput): OpenedSession | undefined => {
  const dir = sessionDir(input.sessionId);
  const existingText = readRegularText(snapshotFile(dir));
  if (existingText !== undefined) {
    const snapshot = parseSnapshot(existingText);
    if (snapshot !== undefined) {
      return { snapshot, rules: snapshot.rules as unknown as Rule[], dir, created: false };
    }
  }
  if (input.rules.length === 0) return undefined;
  const sources = sessionSources(input.projectSources, input.globalSources).map((source) => {
    // The frozen sha is always the bytes on disk at freeze time, even when
    // the rubric itself never had them filled in.
    const diskSha = hashFile(resolveSourcePath(input.root, source.path));
    return { ...source, ...(diskSha === undefined ? {} : { sha: diskSha }) };
  });
  const rules = frozenRules(input.rules);
  const baseTree = input.baseTree === undefined ? null : input.baseTree;
  const baseCommit = input.baseCommit === undefined ? gitHead(input.root) : input.baseCommit;
  const knownFiles = knownFilesAt(input.root, baseTree);
  // Known source versions are git blob ids too, so the commit chain compares
  // one id space: evidence links and on-disk reads both use createBlobId.
  for (const source of sources) {
    if (knownFiles[source.path] !== undefined) continue;
    const bytes = readRegularFile(resolveSourcePath(input.root, source.path));
    if (bytes !== undefined) knownFiles[source.path] = createBlobId(bytes);
  }
  const fingerprint = createRulesFingerprint({
    rules,
    thresholds: input.thresholds,
    sources: sources.map((source) => ({ path: source.path, sha: source.sha })),
  });
  const snapshot: CheckSessionSnapshot = {
    version: 1,
    sessionId: input.sessionId,
    generation: 0,
    root: rootSpelling(input.root),
    ...(input.host === undefined ? {} : { host: input.host }),
    startedAt: input.startedAt ?? new Date().toISOString(),
    baseCommit,
    baseTree,
    sources,
    rules,
    thresholds: input.thresholds,
    fingerprint,
    scope: sessionScopeGlobs(input.projectSources, input.globalSources),
    knownFiles,
    ephemeral: input.ephemeral ?? false,
  };
  const written = createOnce(snapshotFile(dir), `${JSON.stringify(snapshot)}\n`);
  if (!written) {
    const raced = readRegularText(snapshotFile(dir));
    const parsed = raced === undefined ? undefined : parseSnapshot(raced);
    if (parsed !== undefined) {
      return { snapshot: parsed, rules: parsed.rules as unknown as Rule[], dir, created: false };
    }
    return undefined;
  }
  writeStatus(dir, "active", 0);
  if (!snapshot.ephemeral) registerSession(input.root, input.sessionId);
  return { snapshot, rules: snapshot.rules as unknown as Rule[], dir, created: true };
};

export const readSnapshot = (sessionId: string): CheckSessionSnapshot | undefined => {
  const dir = sessionDir(sessionId);
  const text = readRegularText(snapshotFile(dir));
  if (text !== undefined) {
    const parsed = parseSnapshot(text);
    if (parsed !== undefined) return parsed;
  }
  // A rebased id: follow the pointer a bounded number of hops.
  let current = sessionId;
  for (let hop = 0; hop < 16; hop += 1) {
    const pointer = readRegularText(path.join(sessionDir(current), "rebased-to"))?.trim();
    if (pointer === undefined || pointer === "") return undefined;
    current = pointer;
    const next = readRegularText(snapshotFile(sessionDir(current)));
    if (next !== undefined) {
      const parsed = parseSnapshot(next);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
};

/** The id of the live generation for a (possibly rebased) session id. */
export const liveSessionId = (sessionId: string): string => {
  let current = sessionId;
  for (let hop = 0; hop < 16; hop += 1) {
    const pointer = readRegularText(path.join(sessionDir(current), "rebased-to"))?.trim();
    if (pointer === undefined || pointer === "") return current;
    current = pointer;
  }
  return current;
};

export const readSessionStatus = (sessionId: string): StatusRecord | undefined => {
  const text = readRegularText(statusFile(sessionDir(sessionId)));
  if (text === undefined) return undefined;
  try {
    return statusSchemaShape(JSON.parse(text));
  } catch {
    return undefined;
  }
};

export const markSession = (sessionId: string, status: SessionStatus, generation: number): void => {
  writeStatus(sessionDir(sessionId), status, generation);
};

/** Evidence a hook appends: a judged edit chain link or a set of turn verdicts. */
export type Evidence =
  | {
      kind: "edit";
      turnId: string;
      at: string;
      eventId: string;
      path: string;
      before: string | null;
      after: string | null;
      verdicts: VerdictRef[];
    }
  | {
      kind: "turn";
      turnId: string;
      at: string;
      eventId: string;
      files: string[];
      verdicts: VerdictRef[];
    };

export const evidenceDir = (dir: string, turnId: string): string =>
  path.join(dir, "evidence", safe(turnId));

/** First-write-wins by event id: a retried delivery never appends twice. */
export const appendEvidence = (
  dir: string,
  turnId: string,
  eventId: string,
  evidence: Evidence,
): boolean =>
  createOnce(
    path.join(evidenceDir(dir, turnId), `${safe(eventId)}.json`),
    JSON.stringify(evidence),
  );

export const readEvidence = (dir: string, turnId: string): Evidence[] => {
  const out: Evidence[] = [];
  let names: string[];
  try {
    names = readdirSync(evidenceDir(dir, turnId)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const text = readRegularText(path.join(evidenceDir(dir, turnId), name));
    if (text === undefined) continue;
    try {
      out.push(JSON.parse(text) as Evidence);
    } catch {
      // a torn record is ignored rather than failing the commit
    }
  }
  return out;
};

const verdictRefs = (
  verdicts: { ruleId: string; band: VerdictRef["band"] }[],
  files: string[],
): VerdictRef[] =>
  verdicts.map((verdict) => ({ ruleId: verdict.ruleId, band: verdict.band, files: [...files] }));

export { verdictRefs };

export type CommitInput = {
  sessionId: string;
  turnId: string;
  /** Fingerprint the rules on disk have now. */
  currentFingerprint: string;
  changedSources: string[];
  /** Repo-relative files this turn judged. */
  files: readonly string[];
  /** Verdicts this turn produced, across edit and turn checks. */
  verdicts: VerdictRef[];
  /** Blob ids the turn's own evidence last saw, per file; null means deleted. */
  judgedAfter: ReadonlyMap<string, string | null>;
  /** Read a repo-relative file's blob id now, or null when absent. */
  blobNow: (relative: string) => string | null;
};

/**
 * Proves the view is still the one the verdicts were made against: rules
 * unchanged since the session opened, and every judged file explainable as a
 * chain of edits abide itself saw. A file a shell or another tool touched is
 * a conflict, never a silent re-check under new rules.
 */
export const validateCommit = (
  input: CommitInput,
  snapshot: CheckSessionSnapshot,
): SessionValidation => {
  const conflicts: SessionConflict[] = [];
  if (snapshot.fingerprint !== undefined && input.currentFingerprint !== snapshot.fingerprint) {
    conflicts.push({
      kind: "rules",
      oldFingerprint: snapshot.fingerprint,
      newFingerprint: input.currentFingerprint,
      changedSources: input.changedSources,
    });
  }

  const evidence = [
    ...readEvidence(sessionDir(input.sessionId), input.turnId),
    ...(input.turnId === NO_PROMPT_TURN
      ? []
      : readEvidence(sessionDir(input.sessionId), NO_PROMPT_TURN)),
  ];
  const drifted: string[] = [];
  for (const file of input.files) {
    const now = input.blobNow(file);
    const judged = input.judgedAfter.get(file);
    const known = snapshot.knownFiles[file] ?? null;
    const at = judged ?? known;
    if (now === at) continue;
    const links = evidence
      .filter((entry): entry is Extract<Evidence, { kind: "edit" }> => entry.kind === "edit")
      .filter((entry) => entry.path === file)
      .map((entry) => ({ before: entry.before, after: entry.after }));
    if (!chainCovers(at, links, now)) drifted.push(file);
  }
  if (drifted.length > 0) conflicts.push({ kind: "files", drifted });

  if (conflicts.length === 0) {
    return { status: "clean", currentFingerprint: input.currentFingerprint };
  }
  const fileConflict = conflicts.find(
    (conflict): conflict is Extract<(typeof conflicts)[number], { kind: "files" }> =>
      conflict.kind === "files",
  );
  const driftedSet = new Set(fileConflict?.drifted ?? []);
  const rulesChanged = conflicts.some((conflict) => conflict.kind === "rules");
  const affected = input.verdicts.filter((ref) => {
    if (rulesChanged) return true;
    return ref.files.some((file) => driftedSet.has(file));
  });
  // A drift with no model verdict behind it (no key, skipped judge) still
  // invalidates the files themselves: name them under a synthetic ref so the
  // report can point at what moved.
  if (!rulesChanged && affected.length === 0 && driftedSet.size > 0) {
    affected.push({ ruleId: "*", band: "flag", files: [...driftedSet] });
  }
  return { status: "conflict", conflicts, affected };
};

type ChainLink = { before: string | null; after: string | null };

const chainCovers = (
  start: string | null,
  links: readonly ChainLink[],
  now: string | null,
): boolean => {
  const unused = [...links];
  let at = start;
  while (at !== now) {
    const index = unused.findIndex((link) => link.before === at);
    const next = index === -1 ? undefined : unused.splice(index, 1)[0];
    if (next === undefined) return false;
    at = next.after;
  }
  return true;
};

export type RebaseResult =
  { status: "ok"; snapshot: CheckSessionSnapshot; newSessionId: string } | { status: "missing" };

/** A rebase starts a new generation under a fresh session id. */
export const rebaseGenerationId = (sessionId: string, generation: number): string =>
  generation === 0 ? `${sessionId}#2` : `${sessionId}#${generation + 2}`;

/**
 * Opens a fresh session against the rules and tree as they stand now. The
 * conflicted snapshot is moved into the new session's history, never
 * overwritten, so its verdicts stay explainable by the view they were made
 * on. The new session keeps the host's session id in its name; the old
 * directory is left on disk only as the archived history payload.
 */
export const rebaseSession = (
  sessionId: string,
  next: Omit<OpenSessionInput, "sessionId">,
): RebaseResult => {
  // Already rebased: the live generation is the answer, rebasing it again
  // would manufacture generations no conflict asked for.
  const liveId = liveSessionId(sessionId);
  if (liveId !== sessionId) {
    const live = readSnapshot(liveId);
    return live === undefined
      ? { status: "missing" }
      : { status: "ok", snapshot: live, newSessionId: liveId };
  }
  const dir = sessionDir(sessionId);
  const oldText = readRegularText(snapshotFile(dir));
  if (oldText === undefined) return { status: "missing" };
  const old = parseSnapshot(oldText);
  if (old === undefined) return { status: "missing" };

  const newSessionId = rebaseGenerationId(sessionId, old.generation);
  const newDir = sessionDir(newSessionId);
  const opened = ensureSession({ ...next, sessionId: newSessionId });
  if (opened === undefined) return { status: "missing" };

  const snapshot: CheckSessionSnapshot = {
    ...opened.snapshot,
    sessionId: newSessionId,
    generation: old.generation + 1,
  };
  writePrivate(snapshotFile(newDir), `${JSON.stringify(snapshot)}\n`);
  writeStatus(newDir, "active", snapshot.generation);

  const archiveDir = path.join(newDir, "history", String(old.generation));
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  writePrivate(
    path.join(archiveDir, "snapshot.json"),
    `${oldText.endsWith("\n") ? oldText : `${oldText}\n`}`,
  );
  try {
    renameSync(path.join(dir, "status.json"), path.join(archiveDir, "status.json"));
  } catch {
    // status is advisory; the archived snapshot is what matters
  }
  try {
    renameSync(snapshotFile(dir), path.join(archiveDir, "live-snapshot.json"));
  } catch {
    // the archive copy is already on disk
  }
  // A marker in the old id's directory lets a late hook delivery find the
  // generation that superseded it, while readSnapshot(oldId) sees no live view.
  writePrivate(
    path.join(dir, "rebased-to"),
    `${newSessionId}
`,
  );
  if (!snapshot.ephemeral) registerSession(next.root, newSessionId);
  return { status: "ok", snapshot, newSessionId };
};

export const removeSession = (sessionId: string): void => {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch {
    // already gone
  }
};

// ── Idempotent hook delivery ──────────────────────────────────────────────

export type PublishedResult = { output: HookOutput; at: string; ms: number };

const STALE_CLAIM_MS = 60_000;

const resultFile = (dir: string, generation: number, eventId: string): string =>
  path.join(resultsDir(dir, generation), `${safe(eventId)}.json`);
const claimFile = (dir: string, generation: number, eventId: string): string =>
  path.join(claimsDir(dir, generation), `${safe(eventId)}`);

const readResult = (file: string): PublishedResult | undefined => {
  const text = readRegularText(file);
  if (text === undefined) return undefined;
  try {
    const json = JSON.parse(text) as { output: unknown; at: unknown; ms: unknown };
    const output = hookOutputSchema.safeParse(json.output);
    if (!output.success || typeof json.at !== "string" || typeof json.ms !== "number") {
      return undefined;
    }
    return { output: output.data, at: json.at, ms: json.ms };
  } catch {
    return undefined;
  }
};

const claimStale = (file: string): boolean => {
  try {
    const raw = readFileSync(file, "utf8");
    return Date.now() - Number.parseInt(raw.split("|")[1] ?? "0", 10) > STALE_CLAIM_MS;
  } catch {
    return true;
  }
};

export type RunOnceOptions = {
  sessionId: string;
  eventId: string;
  /** Does the work once. Must append its own audit events through appendEventOnce. */
  work: () => Promise<HookOutput> | HookOutput;
  /** Timing for the published result. */
  measureMs: () => number;
  /** How long to wait for a parallel adapter to finish the same delivery. */
  waitMs?: number;
};

/**
 * Runs the work once per (session, event) id, however many host adapters
 * deliver it. The first delivery claims the id; a parallel delivery waits for
 * its result and replays the exact output, so retries produce one event and
 * one set of verdicts.
 */
export const runOnce = async (options: RunOnceOptions): Promise<HookOutput> => {
  const snapshot = readSnapshot(options.sessionId);
  const generation = snapshot?.generation ?? 0;
  const dir = sessionDir(options.sessionId);
  const result = resultFile(dir, generation, options.eventId);
  const existing = readResult(result);
  if (existing !== undefined) return existing.output;

  const claim = claimFile(dir, generation, options.eventId);
  if (createOnce(claim, `${process.pid}|${Date.now()}`)) {
    let output: HookOutput;
    try {
      output = await options.work();
    } catch {
      rmSync(claim, { force: true });
      return { kind: "silent" };
    }
    const record: PublishedResult = {
      output,
      at: new Date().toISOString(),
      ms: options.measureMs(),
    };
    const tmp = `${result}.tmp`;
    if (writePrivate(tmp, JSON.stringify(record))) {
      try {
        renameSync(tmp, result);
      } catch {
        rmSync(tmp, { force: true });
      }
    }
    rmSync(claim, { force: true });
    return output;
  }

  const deadline = Date.now() + (options.waitMs ?? 5_000);
  for (;;) {
    const done = readResult(result);
    if (done !== undefined) return done.output;
    if (Date.now() >= deadline) {
      if (claimStale(claim)) {
        rmSync(claim, { force: true });
        return runOnce(options);
      }
      // The peer is still working and this delivery must not double the event:
      // replay silence rather than judge the same change twice.
      return { kind: "silent" };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Audit events are deduplicated by the same id: one jsonl line per delivery. */
export const eventMarker = (sessionId: string, generation: number, eventId: string): string =>
  path.join(markersDir(sessionDir(sessionId), generation), safe(eventId));
