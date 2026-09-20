import { Box, Text } from "ink";
import type { AbideEvent, Rule } from "@coldtea/abide-schema";
import type { SessionSummary } from "../../commands/report.js";
import { Buckets } from "../components/Buckets.js";
import { Callout } from "../components/Callout.js";
import { Columns } from "../components/Columns.js";
import { Header } from "../components/Header.js";
import { RuleTable, type RuleStats } from "../components/RuleTable.js";
import { Section } from "../components/Section.js";
import { median, ms, usd } from "../../lib/ui.js";
import { glyph, palette } from "../theme.js";

export type ReportData = {
  root: string;
  rules: Rule[];
  events: AbideEvent[];
  stats: Map<string, RuleStats>;
  dead: Rule[];
  problems: string[];
  sessions: SessionSummary[];
};

type Check = Extract<AbideEvent, { kind: "check" }>;

const reasonOf = (rule: Rule): string =>
  rule.check.type === "deferred" || rule.check.type === "unenforceable" ? rule.check.reason : "";

export function ReportView({ data }: { data: ReportData }) {
  const checks = data.events.filter((e): e is Check => e.kind === "check");
  const errors = data.events.filter((e) => e.kind === "error").length;
  const edit = checks.filter((c) => c.phase === "edit");
  const turn = checks.filter((c) => c.phase === "turn");
  const spend = (list: readonly Check[]) => list.reduce((s, c) => s + (c.usage?.costUsd ?? 0), 0);

  const stuck = data.rules.filter((r) => r.status === "weak" || r.status === "noisy");
  const notRunning = [...stuck, ...data.dead];
  const lintable = data.rules.flatMap((r) =>
    r.check.type === "lint"
      ? [
          {
            id: r.id,
            how: r.check.how ?? `pattern: ${r.check.pattern ?? ""}`,
            overlaps: r.check.overlaps,
          },
        ]
      : [],
  );
  const deferred = data.rules.filter((r) => r.check.type === "deferred");
  const unenforceable = data.rules.filter((r) => r.check.type === "unenforceable");
  const quiet = data.rules.filter((r) => {
    const s = data.stats.get(r.id);
    return (
      r.status === "active" &&
      r.check.type === "model" &&
      s !== undefined &&
      s.checks > 0 &&
      s.fired === 0 &&
      s.flagged === 0 &&
      !data.dead.includes(r)
    );
  });

  return (
    <Box flexDirection="column">
      <Header command="report" where={data.root} />
      {data.problems.map((p) => (
        <Callout key={p} tone="warn" title="A rubric could not be read and is being ignored">
          <Text color={palette.mist}>{p}</Text>
        </Callout>
      ))}

      {data.sessions.length > 0 ? (
        <Callout
          tone={data.sessions.some((session) => session.status === "conflicted") ? "bad" : "ok"}
          title={
            data.sessions.some((session) => session.status === "conflicted")
              ? "A check session drifted and needs a rebase"
              : "Check sessions"
          }
        >
          {data.sessions.map((session) => (
            <Box key={`${session.sessionId}:${session.generation}`} flexDirection="column">
              <Text color={session.status === "conflicted" ? palette.rose : palette.cloud}>
                {session.status === "conflicted" ? glyph.cross : glyph.check} {session.sessionId}
                <Text color={palette.ash}>
                  {"  "}
                  gen {session.generation} {glyph.dotSep} rules{" "}
                  {session.fingerprint?.slice(0, 12) ?? "unknown"} {glyph.dotSep}{" "}
                  {session.coveredFiles.length} committed{" "}
                  {session.coveredFiles.length === 1 ? "file" : "files"} {glyph.dotSep}{" "}
                  {session.status}
                </Text>
              </Text>
              {session.conflicts.map((conflict, index) =>
                conflict.conflicts.map((detail, detailIndex) => (
                  <Text key={`${index}:${detailIndex}`} color={palette.ash}>
                    {"    "}
                    {detail.kind === "rules"
                      ? `rules ${detail.oldFingerprint.slice(0, 12)} -> ${detail.newFingerprint.slice(0, 12)}${detail.changedSources.length > 0 ? ` (${detail.changedSources.join(", ")})` : ""}`
                      : `files drifted: ${detail.drifted.join(", ")}`}
                  </Text>
                )),
              )}
            </Box>
          ))}
        </Callout>
      ) : null}

      <Section title="Rules">
        <Buckets rules={data.rules} />
        <Box marginTop={1}>
          <RuleTable
            rules={data.rules}
            stats={checks.length > 0 ? data.stats : undefined}
            runnableOnly
          />
        </Box>
        {quiet.length > 0 ? (
          <Box marginTop={1}>
            <Text color={palette.ash}>
              {quiet.length} {quiet.length === 1 ? "rule has" : "rules have"} answered no on every
              check so far, which is what a clear answer looks like.
            </Text>
          </Box>
        ) : null}
      </Section>

      {notRunning.length > 0 ? (
        <Callout
          tone="warn"
          title={`${notRunning.length} ${notRunning.length === 1 ? "rule is switched off or never answers" : "rules are switched off or never answer"}. Likely badly worded.`}
        >
          {notRunning.map((r) => (
            <Text key={r.id} color={palette.cloud}>
              {r.id}
              <Text color={palette.ash}>
                {"  "}
                {r.status === "weak"
                  ? "weak, off"
                  : r.status === "noisy"
                    ? "noisy, off"
                    : "never fired or flagged"}
                {r.calibration ? ` ${glyph.dotSep} median ${r.calibration.median.toFixed(2)}` : ""}
              </Text>
            </Text>
          ))}
          <Text color={palette.mist}>Run abide tune to rewrite them.</Text>
        </Callout>
      ) : null}

      {lintable.length > 0 ? (
        <Section
          title="For your linter"
          aside={`${lintable.length} ${lintable.length === 1 ? "rule" : "rules"} a linter enforces exactly. Abide does not run them.`}
        >
          <Columns
            indent={2}
            columns={[
              { key: "id", label: "", width: 30 },
              { key: "have", label: "", width: 16 },
              { key: "how", label: "" },
            ]}
            rows={lintable.map((r) => ({
              id: { text: r.id, color: palette.mist },
              how: { text: r.how, color: palette.cloud },
              have: r.overlaps
                ? { text: `${glyph.check} configured`, color: palette.sage }
                : { text: "not configured", color: palette.amber },
            }))}
          />
        </Section>
      ) : null}

      {deferred.length + unenforceable.length > 0 ? (
        <Section
          title="Not checked"
          aside={`${deferred.length} deferred ${glyph.dotSep} ${unenforceable.length} unenforceable`}
        >
          {deferred.length > 0 ? (
            <Box flexDirection="column">
              <Text color={palette.ceramicWarm}>
                Need the rest of the repository, which a diff does not carry
              </Text>
              <Columns
                indent={2}
                columns={[
                  { key: "id", label: "", width: 30 },
                  { key: "why", label: "" },
                ]}
                rows={deferred.map((r) => ({
                  id: { text: r.id, color: palette.mist },
                  why: { text: reasonOf(r), color: palette.ash },
                }))}
              />
            </Box>
          ) : null}
          {unenforceable.length > 0 ? (
            <Box flexDirection="column" marginTop={deferred.length > 0 ? 1 : 0}>
              <Text color={palette.ash}>
                About the process or the conversation, not a change to a file
              </Text>
              <Text color={palette.ash} wrap="wrap">
                {"  "}
                {unenforceable.map((r) => r.id).join(`  ${glyph.dotSep}  `)}
              </Text>
            </Box>
          ) : null}
        </Section>
      ) : null}

      <Section
        title="Checks"
        aside={
          checks.length === 0 ? "none recorded yet" : `${checks.length} in .abide/events.jsonl`
        }
      >
        {checks.length === 0 ? (
          <Text color={palette.ash}>
            Every check the hooks run lands here: what fired, how long it took, what it cost.
          </Text>
        ) : (
          <Box flexDirection="column">
            <Columns
              indent={2}
              columns={[
                { key: "phase", label: "", width: 6 },
                { key: "checks", label: "checks", width: 7, align: "right" },
                { key: "blocked", label: "blocked", width: 8, align: "right" },
                { key: "latency", label: "median", width: 8, align: "right" },
                { key: "spend", label: "spend", width: 10, align: "right" },
                { key: "pad", label: "" },
              ]}
              rows={[edit, turn].map((list, i) => ({
                phase: {
                  text: i === 0 ? "edit" : "turn",
                  color: i === 0 ? palette.mist : palette.plum,
                },
                checks: { text: String(list.length), color: palette.cloud },
                blocked: {
                  text: String(list.filter((c) => c.blocked).length),
                  color: list.some((c) => c.blocked) ? palette.rose : palette.mist,
                },
                latency: {
                  text: list.length ? ms(median(list.map((c) => c.latencyMs)) ?? 0) : "",
                  color: palette.cloud,
                },
                spend: { text: usd(spend(list)), color: palette.ceramic },
                pad: { text: "" },
              }))}
            />
            {errors > 0 ? (
              <Box marginTop={1}>
                <Text color={palette.amber}>
                  {errors} {errors === 1 ? "check" : "checks"} failed or timed out. Those edits went
                  unchecked.
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Section>
    </Box>
  );
}
