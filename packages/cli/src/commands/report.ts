import { parseArgs } from "node:util";
import type { Rule } from "@coldtea/abide-schema";
import { readEvents } from "../lib/events.js";
import {
  liveSessionId,
  readSessionStatus,
  readSnapshot,
  repoSessions,
} from "../lib/checkSession.js";
import type { AbideEvent } from "@coldtea/abide-schema";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot } from "../lib/paths.js";
import { say } from "../lib/ui.js";
import type { RuleStats } from "../ui/components/RuleTable.js";
import { showStatic } from "../ui/render.js";
import { ReportView, type ReportData } from "../ui/views/ReportView.js";
import { InitView } from "../ui/views/InitView.js";

const statsFrom = (events: readonly AbideEvent[]): Map<string, RuleStats> => {
  const stats = new Map<string, RuleStats>();
  for (const event of events) {
    if (event.kind !== "check") continue;
    for (const v of event.verdicts) {
      const s = stats.get(v.ruleId) ?? { checks: 0, fired: 0, flagged: 0 };
      s.checks += 1;
      if (v.band === "act") s.fired += 1;
      if (v.band === "flag") s.flagged += 1;
      stats.set(v.ruleId, s);
    }
  }
  return stats;
};

const MIN_CHECKS_TO_CALL_DEAD = 20;

export type SessionSummary = {
  sessionId: string;
  generation: number;
  status: "active" | "conflicted" | "committed";
  fingerprint?: string;
  coveredFiles: string[];
  conflicts: Extract<AbideEvent, { kind: "session-conflict" }>[];
};

export const collectReport = (root: string): ReportData | undefined => {
  const loaded = loadRules(root);
  if (loaded.rules.length === 0) return undefined;
  const events = readEvents(root);
  const sessionSummaries = summarizeSessions(root, events);
  const stats = statsFrom(events);
  // Dead means it never answers: no fire, no flag, and a calibration that
  // never cleared confidently either. A rule at 0.02 on every check is not
  // dead, it is a rule nobody has broken yet.
  const dead: Rule[] = loaded.rules.filter((rule) => {
    const s = stats.get(rule.id);
    const middling = rule.calibration === undefined || rule.calibration.median >= 0.25;
    return (
      rule.status === "active" &&
      rule.check.type === "model" &&
      middling &&
      s !== undefined &&
      s.checks >= MIN_CHECKS_TO_CALL_DEAD &&
      s.fired === 0 &&
      s.flagged === 0
    );
  });
  return {
    root,
    rules: loaded.rules,
    events,
    stats,
    dead,
    problems: loaded.problems,
    sessions: sessionSummaries,
  };
};

const summarizeSessions = (root: string, events: readonly AbideEvent[]): SessionSummary[] => {
  // Collapse an id and the generations it was rebased into to the live one.
  const ids = [...new Set(repoSessions(root).map((id) => liveSessionId(id)))];
  return ids
    .map((sessionId): SessionSummary | undefined => {
      const snapshot = readSnapshot(sessionId);
      if (snapshot === undefined || snapshot.ephemeral) return undefined;
      const status = readSessionStatus(sessionId)?.status ?? "active";
      const coveredFiles = [
        ...new Set(
          events
            .filter(
              (event): event is Extract<AbideEvent, { kind: "session-commit" }> =>
                event.kind === "session-commit" && event.sessionId === sessionId,
            )
            .flatMap((event) => event.files),
        ),
      ].sort();
      const conflicts = events.filter(
        (event): event is Extract<AbideEvent, { kind: "session-conflict" }> =>
          event.kind === "session-conflict" && event.sessionId === sessionId,
      );
      return {
        sessionId,
        generation: snapshot.generation,
        status,
        fingerprint: snapshot.fingerprint,
        coveredFiles,
        conflicts,
      };
    })
    .filter((summary): summary is SessionSummary => summary !== undefined);
};

/** Rules, calibration, and what has fired so far in this repository. */
export const runReport = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const data = collectReport(root);
  if (data === undefined) {
    if (values.json) {
      say(JSON.stringify({ root, rules: [], events: [] }));
      return 1;
    }
    await showStatic(InitView({ data: { kind: "no-sources", root } }));
    return 1;
  }
  if (values.json) {
    say(
      JSON.stringify({
        root: data.root,
        rules: data.rules,
        stats: Object.fromEntries(data.stats),
        dead: data.dead.map((r) => r.id),
        events: data.events.length,
        sessions: data.sessions.map((session) => ({
          sessionId: session.sessionId,
          generation: session.generation,
          status: session.status,
          fingerprint: session.fingerprint,
          coveredFiles: session.coveredFiles,
          conflicts: session.conflicts.length,
        })),
      }),
    );
    return 0;
  }
  await showStatic(ReportView({ data }));
  return 0;
};
