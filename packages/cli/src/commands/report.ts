import { parseArgs } from "node:util";
import type { AbideEvent, CheckSessionSnapshot, Rule } from "@coldtea/abide-schema";
import { readEvents } from "../lib/events.js";
import { loadRules } from "../lib/loadRules.js";
import { coveredFiles, listSessions } from "../lib/checkSession.js";
import { repoKeyOf } from "../lib/checkSession.js";
import { findRepoRoot } from "../lib/paths.js";
import { say } from "../lib/ui.js";
import type { RuleStats } from "../ui/components/RuleTable.js";
import { showStatic } from "../ui/render.js";
import { ReportView, type ReportData, type SessionSummary } from "../ui/views/ReportView.js";
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

const summarizeSessions = (root: string): SessionSummary[] => {
  const key = repoKeyOf(root);
  const events = readEvents(root);
  return listSessions()
    .filter((s) => s.repoKey === key)
    .map((snapshot: CheckSessionSnapshot): SessionSummary => {
      const sessionEvents = events.filter((e) => e.sessionId === snapshot.sessionId);
      const checks = sessionEvents.filter((e) => e.kind === "check").length;
      const conflicts = sessionEvents.filter((e) => e.kind === "session-conflict").length;
      return {
        sessionId: snapshot.sessionId,
        ruleFingerprint: snapshot.ruleFingerprint,
        ruleCount: snapshot.rules.length,
        scope: snapshot.allowedScope,
        covered: coveredFiles(snapshot),
        base:
          snapshot.base.kind === "git" && snapshot.base.head
            ? snapshot.base.head.slice(0, 7)
            : "files",
        conflict:
          snapshot.conflict === undefined
            ? null
            : {
                what: snapshot.conflict.kind,
                oldFingerprint: snapshot.conflict.oldFingerprint,
                newFingerprint: snapshot.conflict.newFingerprint,
                affectedRules: snapshot.conflict.affectedRules,
              },
        checks,
        conflicts,
        rebased: snapshot.rebasedFrom !== undefined,
      };
    });
};

export const collectReport = (root: string): ReportData | undefined => {
  const loaded = loadRules(root);
  if (loaded.rules.length === 0) return undefined;
  const events = readEvents(root);
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
    sessions: summarizeSessions(root),
  };
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
        root,
        rules: data.rules,
        stats: Object.fromEntries(data.stats),
        dead: data.dead.map((r) => r.id),
        events: data.events.length,
        sessions: data.sessions,
      }),
    );
    return 0;
  }
  await showStatic(ReportView({ data }));
  return 0;
};
