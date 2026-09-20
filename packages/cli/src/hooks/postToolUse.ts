import {
  createBlobId,
  createBlockKey,
  isAbideError,
  postToolUseInputSchema,
  turnIdOf,
  type HookOutput,
  type KnownFile,
  type Rule,
  type Verdict,
} from "@coldtea/abide-schema";
import { runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, MAX_BLOCKS_PER_RULE_PER_TURN } from "../lib/constants.js";
import { hasApiKey } from "../lib/credentials.js";
import { boundState, editsFromPostToolUse, type EditHunk } from "../lib/diff.js";
import {
  awaitResult,
  checkEventId,
  claimEvent,
  commitEvent,
  markConflict,
  openSession,
  thresholdsOf,
  verifySession,
  type CommittedResult,
} from "../lib/checkSession.js";
import { loadSessionInput } from "../lib/checkSessionLoad.js";
import { debug } from "../lib/output.js";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "../lib/paths.js";
import { flagNotice, repairReason } from "../lib/reason.js";
import {
  blockCount,
  incrementBlock,
  readPrompt,
  recordBlockedFile,
  recordChecked,
  recordFileStart,
  turnDir,
} from "../lib/session.js";
import { lastUserPrompt } from "../lib/transcript.js";

type Pair = { rule: Rule; verdict: Verdict };

type Checked = { edit: EditHunk; relative: string; outcome: CheckOutcome };

const conflictNotice = (
  what: "rules" | "files",
  oldFingerprint: string,
  newFingerprint: string,
  affected: readonly string[],
): string =>
  [
    `Abide: the rules or files this session started with changed underneath it (${what} drift), so this check was not committed to the audit.`,
    `old rules ${oldFingerprint.slice(0, 10)} -> new ${newFingerprint.slice(0, 10)}.`,
    affected.length > 0 ? `verdicts affected: ${affected.slice(0, 8).join(", ")}` : "",
    'Run "abide session rebase" to adopt the current rules and continue this session.',
  ]
    .filter((line) => line !== "")
    .join("\n");

export const handlePostToolUse = async (raw: unknown): Promise<HookOutput> => {
  const parsed = postToolUseInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const started = performance.now();
  const at = new Date().toISOString();
  const all = editsFromPostToolUse(input);
  const root = findRepoRoot(all[0]?.filePath ?? input.cwd);
  const edits = all.filter((e) => !isExcludedPath(relativeToRoot(root, e.filePath)));
  if (edits.length === 0) return { kind: "silent" };

  const turn = turnDir(input.session_id, turnIdOf(input));
  for (const edit of edits) recordFileStart(turn, edit.filePath, edit.original);

  // The snapshot is the only rule view the session uses. It is created the
  // first time the session checks; afterwards the rules on disk are irrelevant.
  const snapshot = openSession(input.session_id, root, () =>
    loadSessionInput(root, { sessionId: input.session_id, turnId: turnIdOf(input) }),
  );
  if (snapshot === undefined || snapshot.rules.length === 0) return { kind: "silent" };
  const rules = snapshot.rules;
  const thresholds = thresholdsOf(snapshot);

  const checkable: { edit: EditHunk; relative: string; diff: string }[] = [];
  const tooLarge: string[] = [];
  for (const edit of edits) {
    const relative = relativeToRoot(root, edit.filePath);
    if (edit.text === undefined) {
      tooLarge.push(relative);
      continue;
    }
    const { text: diff } = boundState(edit.text);
    if (diff.trim() !== "") checkable.push({ edit, relative, diff });
  }
  if (tooLarge.length > 0) {
    const skipId = checkEventId(
      input.session_id,
      "edit",
      turnIdOf(input),
      input.tool_use_id,
      tooLarge,
    );
    const claim = claimEvent(input.session_id, {
      eventId: skipId,
      phase: "edit",
      files: tooLarge,
    });
    if (claim.status === "won") {
      commitEvent(
        root,
        input.session_id,
        skipId,
        {
          kind: "skip",
          at,
          phase: "edit",
          sessionId: input.session_id,
          eventId: skipId,
          reason: "diff too large to compute in time",
          files: tooLarge,
        },
        { kind: "silent" },
      );
    }
  }
  if (checkable.length === 0) return { kind: "silent" };
  const files = checkable.map((c) => c.relative);
  const afterBlobs: KnownFile[] = checkable
    .filter((c) => c.edit.after !== null)
    .map((c) => ({ path: c.relative, blob: createBlobId(c.edit.after as string) }));

  const eventId = checkEventId(input.session_id, "edit", turnIdOf(input), input.tool_use_id, files);
  const claim = claimEvent(input.session_id, {
    eventId,
    phase: "edit",
    files,
    ...(afterBlobs.length > 0 ? { afterBlobs } : {}),
  });
  if (claim.status === "duplicate") {
    // A retry or a second adapter delivered the same event: one check only.
    const result =
      claim.result ?? (await awaitResult(input.session_id, eventId, EDIT_CHECK_TIMEOUT_MS));
    return result?.output ?? { kind: "silent" };
  }

  // Drift is settled before anything else: a view that changed is neither
  // judged nor silently skipped, and needs no key to notice.
  const drift = verifySession(snapshot, root, files, afterBlobs);
  if (drift.kind !== "clean") {
    markConflict(snapshot, drift, files);
    const systemMessage = conflictNotice(
      drift.kind,
      drift.oldFingerprint,
      drift.newFingerprint,
      drift.affectedRules,
    );
    commitEvent(
      root,
      input.session_id,
      eventId,
      {
        kind: "session-conflict",
        at,
        sessionId: input.session_id,
        eventId,
        phase: "edit",
        what: drift.kind,
        oldFingerprint: drift.oldFingerprint,
        newFingerprint: drift.newFingerprint,
        files: drift.kind === "files" ? drift.changed : files,
        affectedRules: drift.affectedRules,
      },
      { kind: "notice", systemMessage },
    );
    return { kind: "notice", systemMessage };
  }

  if (!hasApiKey(root)) {
    const committed = commitEvent(
      root,
      input.session_id,
      eventId,
      {
        kind: "skip",
        at,
        phase: "edit",
        sessionId: input.session_id,
        eventId,
        reason: "no api key",
        files,
      },
      { kind: "silent" },
    );
    return committed?.output ?? { kind: "silent" };
  }

  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(turn);
  let checked: Checked[];
  try {
    checked = await Promise.all(
      checkable.map(async ({ edit, relative, diff }) => ({
        edit,
        relative,
        outcome: await runCheck({
          phase: "edit",
          fileDiffs: [{ file: relative, text: diff }],
          task,
          rules,
          thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
        }),
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    commitEvent(
      root,
      input.session_id,
      eventId,
      {
        kind: "error",
        at,
        phase: "edit",
        sessionId: input.session_id,
        eventId,
        code: isAbideError(error) ? error.code : "CHECK_FAILED",
        message,
        latencyMs: Math.round(performance.now() - started),
      },
      { kind: "silent" },
    );
    return { kind: "silent" };
  }
  for (const { edit, relative } of checked) {
    if (edit.after === null) continue;
    recordChecked(turn, {
      path: relative,
      before: edit.original === null ? null : createBlobId(edit.original),
      after: createBlobId(edit.after),
    });
  }

  const byId = new Map(rules.map((r) => [r.id, r]));
  const acting: Pair[] = [];
  const flagged: Pair[] = [];
  const actedOn: string[] = [];
  const verdicts: Verdict[] = [];
  let modelRules = 0;
  let modelLatencyMs = 0;
  for (const { relative, outcome } of checked) {
    modelRules += outcome.modelRules.length;
    modelLatencyMs = Math.max(modelLatencyMs, outcome.modelLatencyMs);
    verdicts.push(...outcome.verdicts);
    const pairs = (band: Verdict["band"]): Pair[] =>
      outcome.verdicts.flatMap((verdict) => {
        const rule = byId.get(verdict.ruleId);
        return rule !== undefined && verdict.band === band ? [{ rule, verdict }] : [];
      });
    const actPairs = pairs("act");
    const actingHere = actPairs.filter(
      ({ rule }) =>
        blockCount(turn, createBlockKey(rule.id, relative)) < MAX_BLOCKS_PER_RULE_PER_TURN,
    );
    for (const { rule } of actingHere) incrementBlock(turn, createBlockKey(rule.id, relative));
    if (actingHere.length > 0) {
      actedOn.push(relative);
      recordBlockedFile(turn, relative);
    }
    acting.push(...actingHere);
    flagged.push(...pairs("flag"), ...actPairs.filter((pair) => !actingHere.includes(pair)));
  }

  const systemMessage = flagged.length > 0 ? flagNotice("edit", flagged, files) : undefined;
  const output: HookOutput =
    acting.length > 0
      ? {
          kind: "block",
          reason: repairReason("edit", acting, actedOn),
          ...(systemMessage === undefined ? {} : { systemMessage }),
        }
      : systemMessage === undefined
        ? { kind: "silent" }
        : { kind: "notice", systemMessage };

  // One event for the one delivered event id. The audit gains it only if the
  // append completes; otherwise nothing is published and a retry takes over.
  const committed = commitEvent(
    root,
    input.session_id,
    eventId,
    {
      kind: "check",
      at,
      phase: "edit",
      sessionId: input.session_id,
      eventId,
      promptId: turnIdOf(input),
      files,
      rules: modelRules,
      latencyMs: Math.round(performance.now() - started),
      modelLatencyMs,
      usage: mergeUsage(checked.map((c) => c.outcome.usage)),
      verdicts,
      blocked: acting.length > 0,
    },
    output,
  );
  if (committed === undefined) debug(`post-tool-use: could not commit event ${eventId}`);
  return output;
};

const mergeUsage = (list: CheckOutcome["usage"][]) =>
  list.reduce(
    (sum, usage) => ({
      inputTokens: (sum.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (sum.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      costUsd: (sum.costUsd ?? 0) + (usage.costUsd ?? 0),
    }),
    {} as CheckOutcome["usage"],
  );
