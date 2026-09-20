import { parseArgs } from "node:util";
import { AbideError } from "@coldtea/abide-schema";
import {
  liveSessionId,
  readSessionStatus,
  readSnapshot,
  rebaseSession,
  repoSessions,
} from "../lib/checkSession.js";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot } from "../lib/paths.js";
import { say } from "../lib/ui.js";
import { showStatic } from "../ui/render.js";
import { Box, Text } from "ink";
import { Header } from "../ui/components/Header.js";
import { palette, glyph } from "../ui/theme.js";

const pickSession = (root: string, wanted: string | undefined): string => {
  if (wanted !== undefined) {
    // Validate against the live generation, but keep the given id: rebase is
    // idempotent on an already-rebased id and would no-op if we resolved it.
    if (readSnapshot(wanted) === undefined) {
      throw new AbideError("SESSION_NOT_FOUND", `no check session "${wanted}" is saved here`);
    }
    return wanted;
  }
  const conflicted = [...new Set(repoSessions(root).map((id) => liveSessionId(id)))].filter(
    (id) => readSessionStatus(id)?.status === "conflicted",
  );
  const unique = [...new Set(conflicted)];
  const only = unique[0];
  if (unique.length === 1 && only !== undefined) return only;
  if (unique.length === 0) {
    throw new AbideError(
      "SESSION_NOT_FOUND",
      "no conflicted check session in this repository; pass a session id",
    );
  }
  throw new AbideError(
    "SESSION_CONFLICT",
    `more than one conflicted session: ${unique.join(", ")}; pass one`,
  );
};

const runRebase = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const sessionId = pickSession(root, positionals[0]);
  const loaded = loadRules(root);
  if (loaded.rules.length === 0) {
    throw new AbideError(
      "RUBRIC_MISSING",
      "no rubric here or in ~/.abide; run abide compile first",
    );
  }
  const result = rebaseSession(sessionId, {
    root,
    rules: loaded.rules,
    thresholds: loaded.thresholds,
    projectSources: loaded.project?.sources ?? [],
    globalSources: loaded.global?.sources ?? [],
  });
  if (result.status === "missing") {
    throw new AbideError("SESSION_NOT_FOUND", `the session "${sessionId}" disappeared from disk`);
  }
  const { snapshot } = result;
  if (values.json) {
    say(
      JSON.stringify({
        sessionId: result.newSessionId,
        generation: snapshot.generation,
        fingerprint: snapshot.fingerprint,
        files: Object.keys(snapshot.knownFiles).length,
      }),
    );
    return 0;
  }
  await showStatic(
    <Box flexDirection="column">
      <Header command="session rebase" where={root} />
      <Text color={palette.sage}>
        {glyph.check} opened a fresh session (generation {snapshot.generation}) against the rules
        and files as they stand now
      </Text>
      <Text color={palette.ash}>
        rules {glyph.dotSep} {snapshot.rules.length} {glyph.dotSep} fingerprint{" "}
        {snapshot.fingerprint?.slice(0, 12)} {glyph.dotSep} known files{" "}
        {Object.keys(snapshot.knownFiles).length}
      </Text>
      <Text color={palette.mist}>
        The old verdicts stay in .abide/events.jsonl against the old view.
      </Text>
    </Box>,
  );
  return 0;
};

const runStatus = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const rows = [...new Set(repoSessions(root).map((id) => liveSessionId(id)))]
    .map((id) => ({ id, snapshot: readSnapshot(id), status: readSessionStatus(id) }))
    .filter((row) => row.snapshot !== undefined);
  if (values.json) {
    say(
      JSON.stringify(
        rows.map((row) => ({
          sessionId: row.id,
          generation: row.snapshot?.generation ?? 0,
          status: row.status?.status ?? "active",
          fingerprint: row.snapshot?.fingerprint,
          files: Object.keys(row.snapshot?.knownFiles ?? {}).length,
        })),
      ),
    );
    return 0;
  }
  await showStatic(
    <Box flexDirection="column">
      <Header command="session" where={root} />
      {rows.length === 0 ? (
        <Text color={palette.ash}>No check sessions recorded here yet.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((row) => (
            <Text
              key={row.id}
              color={row.status?.status === "conflicted" ? palette.rose : palette.cloud}
            >
              {row.status?.status === "conflicted" ? glyph.cross : glyph.dot} {row.id}
              <Text color={palette.ash}>
                {"  "}
                gen {row.snapshot?.generation ?? 0} {glyph.dotSep}{" "}
                {row.snapshot?.fingerprint?.slice(0, 12) ?? "no fingerprint"} {glyph.dotSep}{" "}
                {Object.keys(row.snapshot?.knownFiles ?? {}).length} known files {glyph.dotSep}{" "}
                {row.status?.status ?? "active"}
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>,
  );
  return 0;
};

export const runSession = async (argv: string[]): Promise<number> => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "rebase":
      return runRebase(rest);
    case "status":
      return runStatus(rest);
    default:
      throw new AbideError(
        "SESSION_NOT_FOUND",
        'unknown session command; use "abide session status" or "abide session rebase"',
      );
  }
};
