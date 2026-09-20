import {
  createBlobId,
  createBlockKey,
  createHookEventId,
  isAbideError,
  postToolUseInputSchema,
  turnIdOf,
  type HookOutput,
  type Rule,
  type Verdict,
} from "@coldtea/abide-schema";
import { runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import { appendEvidence, verdictRefs } from "../lib/checkSession.js";
import { openFrozenSession } from "../lib/frozenSession.js";
import { EDIT_CHECK_TIMEOUT_MS, MAX_BLOCKS_PER_RULE_PER_TURN } from "../lib/constants.js";
import { hasApiKey } from "../lib/credentials.js";
import { boundState, editsFromPostToolUse, type EditHunk } from "../lib/diff.js";
import { appendEventOnce } from "../lib/events.js";
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

  const turnId = turnIdOf(input);
  const turn = turnDir(input.session_id, turnId);
  for (const edit of edits) recordFileStart(turn, edit.filePath, edit.original);

  const opened = openFrozenSession(input.session_id, root);
  if (opened === undefined) return { kind: "silent" };
  const { snapshot } = opened;
  const rules = opened.rules;

  const eventId = createHookEventId({
    sessionId: input.session_id,
    event: "PostToolUse",
    turnId,
    toolUseId: input.tool_use_id,
  });

  const checkable: { edit: EditHunk; relative: string; diff: string }[] = [];
  for (const edit of edits) {
    const relative = relativeToRoot(root, edit.filePath);
    if (edit.text === undefined) {
      appendEventOnce(root, input.session_id, snapshot.generation, eventId, {
        kind: "skip",
        at,
        phase: "edit",
        sessionId: input.session_id,
        eventId,
        reason: "diff too large to compute in time",
        files: [relative],
      });
      continue;
    }
    const { text: diff } = boundState(edit.text);
    if (diff.trim() !== "") checkable.push({ edit, relative, diff });
  }
  if (checkable.length === 0) return { kind: "silent" };
  const files = checkable.map((c) => c.relative);

  const apiKey = hasApiKey(root);
  if (!apiKey) {
    appendEventOnce(root, input.session_id, snapshot.generation, `${eventId}:skip`, {
      kind: "skip",
      at,
      phase: "edit",
      sessionId: input.session_id,
      eventId: `${eventId}:skip`,
      reason: "no api key",
      files,
    });
  }

  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(turn);
  if (!apiKey) {
    // No judge this edit, but the edit itself is still evidence: the Stop
    // commit needs the before/after chain to prove the file did not move.
    for (const { edit, relative } of checkable) {
      if (edit.after === null) continue;
      const record = {
        path: relative,
        before: edit.original === null ? null : createBlobId(edit.original),
        after: createBlobId(edit.after),
      };
      recordChecked(turn, record);
      appendEvidence(opened.dir, turnId ?? "turn", eventId, {
        kind: "edit",
        turnId: turnId ?? "turn",
        at,
        eventId,
        path: relative,
        before: record.before,
        after: record.after,
        verdicts: [],
      });
    }
    return { kind: "silent" };
  }
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
          thresholds: snapshot.thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
        }),
      })),
    );
  } catch (error) {
    appendEventOnce(root, input.session_id, snapshot.generation, eventId, {
      kind: "error",
      at,
      phase: "edit",
      sessionId: input.session_id,
      eventId,
      code: isAbideError(error) ? error.code : "CHECK_FAILED",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    });
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
  for (const { edit, relative, outcome } of checked) {
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
    flagged.push(...pairs("flag"), ...actPairs.filter((p) => !actingHere.includes(p)));

    appendEvidence(opened.dir, turnId ?? "turn", eventId, {
      kind: "edit",
      turnId: turnId ?? "turn",
      at,
      eventId,
      path: relative,
      before: edit.original === null ? null : createBlobId(edit.original),
      after: edit.after === null ? null : createBlobId(edit.after),
      verdicts: verdictRefs(outcome.verdicts, [relative]),
    });

    appendEventOnce(root, input.session_id, snapshot.generation, eventId, {
      kind: "check",
      at,
      phase: "edit",
      sessionId: input.session_id,
      promptId: turnId,
      eventId,
      fingerprint: snapshot.fingerprint,
      files: [relative],
      rules: outcome.modelRules.length,
      latencyMs: Math.round(performance.now() - started),
      modelLatencyMs: outcome.modelLatencyMs,
      usage: outcome.usage,
      verdicts: outcome.verdicts,
      blocked: actingHere.length > 0,
    });
  }

  const systemMessage = flagged.length > 0 ? flagNotice("edit", flagged, files) : undefined;
  if (acting.length > 0) {
    return {
      kind: "block",
      reason: repairReason("edit", acting, actedOn),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    };
  }
  return systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage };
};
