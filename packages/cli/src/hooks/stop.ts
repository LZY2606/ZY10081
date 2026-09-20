import { existsSync } from "node:fs";
import path from "node:path";
import {
  createBlobId,
  createHookEventId,
  createRulesFingerprint,
  isAbideError,
  stopInputSchema,
  turnIdOf,
  type HookOutput,
  type Rule,
  type SessionConflict,
  type Verdict,
} from "@coldtea/abide-schema";
import { mergeOutcomes, runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import { appendEvidence, markSession, validateCommit, verdictRefs } from "../lib/checkSession.js";
import {
  MAX_STOP_CHECKS_PER_TURN,
  STOP_FALLBACK_DIFF_TIMEOUT_MS,
  STOP_GIT_TIMEOUT_MS,
  TURN_CHECK_TIMEOUT_MS,
} from "../lib/constants.js";
import { editsCoverFile } from "../lib/coverage.js";
import { boundState, remainingMs, unifiedDiff } from "../lib/diff.js";
import { appendEventOnce } from "../lib/events.js";
import { blobIdsAt, diffTrees, snapshotTree, splitDiff, type FileDiff } from "../lib/git.js";
import { hasApiKey } from "../lib/credentials.js";
import { debug } from "../lib/output.js";
import { openFrozenSession } from "../lib/frozenSession.js";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot, isExcludedPath, relativeToRoot, resolveSourcePath } from "../lib/paths.js";
import { readRegularFile, readRegularText } from "../lib/regularFile.js";
import { hashFile } from "../lib/sources.js";
import { flagNotice, repairReason } from "../lib/reason.js";
import {
  clearTurn,
  hasTurnState,
  incrementStopChecks,
  readBaseline,
  readBlockedFiles,
  readBaselineStatus,
  readChecked,
  readFileStarts,
  readPrompt,
  stopCheckCount,
  turnDir,
} from "../lib/session.js";
import { lastUserPrompt } from "../lib/transcript.js";

export type TurnDiff =
  | {
      kind: "complete";
      files: string[];
      fileDiffs: FileDiff[];
      source: "git" | "files";
      /** Blob id at turn start per file; null if absent then, undefined if git could not say. */
      startIds: Map<string, string | null> | undefined;
    }
  | { kind: "incomplete"; reason: string; missing: string[] };

export const turnDiff = (root: string, dir: string): TurnDiff => {
  const status = readBaselineStatus(dir);
  if (status === "failed" || status === "pending") {
    return {
      kind: "incomplete",
      reason: "git could not snapshot the working tree at turn start",
      missing: [],
    };
  }
  const baseline = readBaseline(dir);
  if (baseline !== undefined) {
    const started = performance.now();
    const now = snapshotTree(root, path.join(dir, "index"), STOP_GIT_TIMEOUT_MS);
    const left = Math.floor(STOP_GIT_TIMEOUT_MS - (performance.now() - started));
    const patch = now === undefined || left <= 0 ? undefined : diffTrees(root, baseline, now, left);
    if (patch === undefined)
      return {
        kind: "incomplete",
        reason: "git could not snapshot the working tree in time",
        missing: [],
      };
    const fileDiffs = splitDiff(patch);
    const files = fileDiffs.map((f) => f.file);
    const stillLeft = Math.floor(STOP_GIT_TIMEOUT_MS - (performance.now() - started));
    const ids = stillLeft <= 0 ? undefined : blobIdsAt(root, baseline, files, stillLeft);
    return {
      kind: "complete",
      files,
      fileDiffs,
      source: "git",
      startIds: ids === undefined ? undefined : new Map(files.map((f) => [f, ids.get(f) ?? null])),
    };
  }
  const deadline = performance.now() + STOP_FALLBACK_DIFF_TIMEOUT_MS;
  const fileDiffs: FileDiff[] = [];
  const missing: string[] = [];
  const startIds = new Map<string, string | null>();
  for (const start of readFileStarts(dir)) {
    const relative = relativeToRoot(root, start.path);
    if (relative.startsWith("..") || isExcludedPath(relative)) continue;
    const after = readRegularText(start.path) ?? null;
    if (after === null && existsSync(start.path)) {
      missing.push(relative);
      continue;
    }
    if (start.original === after) continue;
    const patch = unifiedDiff(relative, start.original ?? "", after ?? "", remainingMs(deadline));
    if (patch === undefined) {
      missing.push(relative);
      continue;
    }
    fileDiffs.push(...splitDiff(patch));
    startIds.set(relative, start.original === null ? null : createBlobId(start.original));
  }
  if (missing.length > 0) {
    return {
      kind: "incomplete",
      reason: "some files changed this turn could not be diffed in time",
      missing,
    };
  }
  return {
    kind: "complete",
    files: fileDiffs.map((f) => f.file),
    fileDiffs,
    source: "files",
    startIds,
  };
};

type Pair = { rule: Rule; verdict: Verdict };

const deliveryEventId = (sessionId: string, turnId: string | undefined, attempt: number): string =>
  createHookEventId({ sessionId, event: "Stop", turnId, attempt });

const conflictNotice = (conflicts: readonly SessionConflict[], generation: number): string => {
  const lines = conflicts.map((conflict) => {
    switch (conflict.kind) {
      case "rules":
        return `- rules changed mid-session: ${conflict.oldFingerprint.slice(0, 12)} -> ${conflict.newFingerprint.slice(0, 12)}${conflict.changedSources.length > 0 ? ` (${conflict.changedSources.join(", ")})` : ""}`;
      case "files":
        return `- files changed outside the recorded edits: ${conflict.drifted.join(", ")}`;
      default:
        return conflict;
    }
  });
  return [
    `Abide: this check session (generation ${generation}) can no longer be committed, because the view it judged against has moved:`,
    ...lines,
    'The verdicts above were made against the old view. Ask the user to run "abide session rebase" to open a fresh session against the current rules and files.',
  ].join("\n");
};

export const handleStop = async (raw: unknown): Promise<HookOutput> => {
  const parsed = stopInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const started = performance.now();
  const at = new Date().toISOString();
  const root = findRepoRoot(input.cwd);
  const turnId = turnIdOf(input);
  const dir = turnDir(input.session_id, turnId);

  const finish = (output: HookOutput): HookOutput => {
    if (output.kind !== "block") clearTurn(dir);
    return output;
  };

  if (!hasTurnState(dir)) return finish({ kind: "silent" });
  if (stopCheckCount(dir) >= MAX_STOP_CHECKS_PER_TURN) return finish({ kind: "silent" });
  // The host is asking again while a block decision from this same attempt
  // is still on screen. Repeating the check would loop; let the block stand.
  if (input.stop_hook_active === true && stopCheckCount(dir) > 0) {
    return { kind: "silent" };
  }

  const opened = openFrozenSession(input.session_id, root);
  if (opened === undefined) return finish({ kind: "silent" });
  const { snapshot } = opened;
  const rules = opened.rules;

  const turn = turnDiff(root, dir);
  if (turn.kind === "incomplete") {
    const eventId = `${deliveryEventId(input.session_id, turnId, stopCheckCount(dir))}:incomplete`;
    appendEventOnce(root, input.session_id, snapshot.generation, eventId, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      eventId,
      reason: `turn diff incomplete: ${turn.reason}`,
      files: turn.missing,
    });
    return finish({ kind: "silent" });
  }
  const { files, fileDiffs } = turn;
  if (files.length === 0) return finish({ kind: "silent" });
  const bounded = fileDiffs.map((f) => ({
    file: f.file,
    text: boundState(f.text, 8_000).text,
  }));
  // Versions as they stood when the judge looked at them. A file changed
  // between this read and the commit validation is external drift.
  const judgedAtCheck = new Map<string, string | null>();
  for (const file of files) {
    const text = readRegularText(path.join(root, file));
    judgedAtCheck.set(file, text === undefined ? null : createBlobId(text));
  }

  const deliveryAttempt = stopCheckCount(dir);
  const stopEventId = deliveryEventId(input.session_id, turnId, deliveryAttempt);
  const apiKey = hasApiKey(root);
  if (!apiKey) {
    appendEventOnce(root, input.session_id, snapshot.generation, `${stopEventId}:skip`, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      eventId: `${stopEventId}:skip`,
      reason: "no api key",
      files,
    });
  }
  incrementStopChecks(dir);
  // Edit-phase rules rerun on files the edit checks did not see whole, and on
  // blocked ones: a block the agent ignored must not end the turn quietly.
  const checked = readChecked(dir);
  const blocked = readBlockedFiles(dir);
  const covered = (file: string): boolean => {
    if (turn.startIds === undefined || blocked.has(file)) return false;
    const now = readRegularFile(path.join(root, file));
    if (now === undefined) return false;
    const start = turn.startIds.get(file) ?? null;
    return editsCoverFile(
      start,
      checked.filter((e) => e.path === file),
      createBlobId(now),
    );
  };
  const unchecked = bounded.filter((f) => !covered(f.file));
  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(dir);
  let outcome: CheckOutcome;
  if (!apiKey) {
    // No judge this turn; the commit below still proves the frozen view held.
    outcome = { verdicts: [], modelRules: [], calls: 0, usage: {}, modelLatencyMs: 0 };
  } else
    try {
      const turnOutcome = await runCheck({
        phase: "turn",
        fileDiffs: bounded,
        task,
        rules,
        thresholds: snapshot.thresholds,
        timeoutMs: TURN_CHECK_TIMEOUT_MS,
      });
      const editOutcomes = await Promise.all(
        unchecked.map((f) =>
          runCheck({
            phase: "edit",
            fileDiffs: [f],
            task,
            rules,
            thresholds: snapshot.thresholds,
            timeoutMs: TURN_CHECK_TIMEOUT_MS,
          }),
        ),
      );
      outcome = mergeOutcomes([turnOutcome, ...editOutcomes]);
    } catch (error) {
      appendEventOnce(root, input.session_id, snapshot.generation, stopEventId, {
        kind: "error",
        at,
        phase: "turn",
        sessionId: input.session_id,
        eventId: stopEventId,
        code: isAbideError(error) ? error.code : "CHECK_FAILED",
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Math.round(performance.now() - started),
      });
      return finish({ kind: "silent" });
    }

  const byId = new Map(rules.map((r) => [r.id, r]));
  const pairs = (band: Verdict["band"]): Pair[] =>
    outcome.verdicts.flatMap((verdict) => {
      const rule = byId.get(verdict.ruleId);
      return rule !== undefined && verdict.band === band ? [{ rule, verdict }] : [];
    });
  const acting = pairs("act");
  const flagged = pairs("flag");

  // The version the last judge actually saw. An edit judge's after-blob is
  // the judged version even if the disk has since moved; files no edit judge
  // saw use the turn judge's read. Either way validation compares against
  // what was judged, never against the disk as it happens to stand now.
  const judgedAfter = new Map<string, string | null>();
  for (const file of files) judgedAfter.set(file, judgedAtCheck.get(file) ?? null);
  for (const record of readChecked(dir)) {
    if (files.includes(record.path)) judgedAfter.set(record.path, record.after);
  }

  const refs = verdictRefs(outcome.verdicts, files);
  // Re-read what the rules would be if the session opened now. This read is
  // only to prove they have not moved; the verdicts above still came from the
  // frozen set. Rules are never silently swapped under a running session.
  const current = loadRules(root);
  const sourceOf = (origin: "project" | "global") =>
    (origin === "project" ? current.project?.sources : current.global?.sources) ?? [];
  const currentSnapshotSources = snapshot.sources.map((source) => ({
    path: source.path,
    sha: hashFile(resolveSourcePath(root, source.path)),
  }));
  const changedSources = currentSnapshotSources
    .filter((now) => {
      const before = snapshot.sources.find((source) => source.path === now.path)?.sha;
      return now.sha !== undefined && before !== undefined && now.sha !== before;
    })
    .map((source) => source.path);
  const currentFingerprint = createRulesFingerprint({
    rules: current.rules,
    thresholds: current.thresholds,
    sources: [
      ...sourceOf("project").map((source) => ({ origin: "project" as const, ...source })),
      ...sourceOf("global").map((source) => ({ origin: "global" as const, ...source })),
    ].map((source) => {
      const diskSha = hashFile(resolveSourcePath(root, source.path));
      return { path: source.path, ...(diskSha === undefined ? {} : { sha: diskSha }) };
    }),
  });

  const blobNow = (relative: string): string | null => {
    const text = readRegularText(path.join(root, relative));
    return text === undefined ? null : createBlobId(text);
  };

  const validation = validateCommit(
    {
      sessionId: input.session_id,
      turnId: turnId ?? "turn",
      currentFingerprint,
      changedSources,
      files,
      verdicts: refs,
      judgedAfter,
      blobNow,
    },
    snapshot,
  );

  if (validation.status === "conflict") {
    const logged = appendEventOnce(root, input.session_id, snapshot.generation, stopEventId, {
      kind: "session-conflict",
      at,
      sessionId: input.session_id,
      generation: snapshot.generation,
      eventId: stopEventId,
      conflicts: validation.conflicts,
      affected: validation.affected,
    });
    // Same ordering as a clean commit: the audit line lands before the status
    // flips, so a failure in between leaves no half-written conflict record.
    if (logged) markSession(input.session_id, "conflicted", snapshot.generation);
    for (const problem of validation.conflicts) debug(`session conflict: ${problem.kind}`);
    return finish({
      kind: "block",
      reason: conflictNotice(validation.conflicts, snapshot.generation),
    });
  }

  if (apiKey)
    appendEventOnce(root, input.session_id, snapshot.generation, stopEventId, {
      kind: "check",
      at,
      phase: "turn",
      sessionId: input.session_id,
      promptId: turnId,
      eventId: stopEventId,
      fingerprint: snapshot.fingerprint,
      files,
      rules: outcome.modelRules.length,
      latencyMs: Math.round(performance.now() - started),
      modelLatencyMs: outcome.modelLatencyMs,
      usage: outcome.usage,
      verdicts: outcome.verdicts,
      blocked: acting.length > 0,
    });
  appendEvidence(opened.dir, turnId ?? "turn", stopEventId, {
    kind: "turn",
    turnId: turnId ?? "turn",
    at,
    eventId: stopEventId,
    files,
    verdicts: refs,
  });

  appendEventOnce(root, input.session_id, snapshot.generation, `${stopEventId}:commit`, {
    kind: "session-commit",
    at,
    sessionId: input.session_id,
    generation: snapshot.generation,
    eventId: `${stopEventId}:commit`,
    fingerprint: snapshot.fingerprint ?? currentFingerprint,
    files,
    verdicts: outcome.verdicts.length,
  });
  markSession(input.session_id, "committed", snapshot.generation);

  const systemMessage = flagged.length > 0 ? flagNotice("turn", flagged, files) : undefined;
  if (acting.length > 0) {
    return finish({
      kind: "block",
      reason: repairReason("turn", acting, files),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    });
  }
  return finish(
    systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage },
  );
};
