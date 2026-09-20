import { parseArgs } from "node:util";
import { AbideError } from "@coldtea/abide-schema";
import { assertNever } from "@coldtea/abide-schema";
import { findRepoRoot } from "../lib/paths.js";
import { listSessions, rebaseSession } from "../lib/checkSession.js";
import { loadSessionInput } from "../lib/checkSessionLoad.js";
import { say } from "../lib/ui.js";
import { showStatic } from "../ui/render.js";
import { SessionView } from "../ui/views/SessionView.js";

/** `abide session rebase [session-id]`: adopt the current rules mid-session. */
export const runSession = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });
  const sub = positionals[0] ?? "list";
  const root = findRepoRoot(process.cwd());

  switch (sub) {
    case "list":
      return listCommand(root, values.json);
    case "rebase":
      return rebaseCommand(root, positionals[1], values.json);
    default:
      throw new AbideError(
        "SESSION_NOT_FOUND",
        `unknown session command "${sub}"; try: abide session rebase`,
      );
  }
};

const listCommand = async (root: string, asJson: boolean): Promise<number> => {
  const sessions = listSessions();
  if (asJson) {
    say(
      JSON.stringify(
        sessions.map((s) => ({
          sessionId: s.sessionId,
          ruleFingerprint: s.ruleFingerprint,
          conflict: s.conflict?.kind ?? null,
          base: s.base.kind === "git" ? s.base.head : "files",
        })),
      ),
    );
    return 0;
  }
  await showStatic(SessionView({ sessions }));
  void root;
  return 0;
};

const rebaseCommand = async (
  root: string,
  sessionIdArg: string | undefined,
  asJson: boolean,
): Promise<number> => {
  const sessionId =
    sessionIdArg ??
    listSessions().find((s) => s.conflict !== undefined)?.sessionId ??
    listSessions()[0]?.sessionId;
  if (sessionId === undefined)
    throw new AbideError("SESSION_NOT_FOUND", "no check session on this machine");

  const result = rebaseSession(sessionId, root, () => loadSessionInput(root));
  switch (result.kind) {
    case "ok":
      if (asJson) {
        say(
          JSON.stringify({
            sessionId,
            ruleFingerprint: result.snapshot.ruleFingerprint,
            base: result.snapshot.base.kind === "git" ? result.snapshot.base.head : "files",
          }),
        );
        return 0;
      }
      say(
        `Rebased session ${sessionId.slice(0, 16)} onto rules ${result.snapshot.ruleFingerprint.slice(0, 10)}. The old snapshot is kept under the session's history.`,
      );
      return 0;
    case "missing":
      throw new AbideError(
        "SESSION_NOT_FOUND",
        `no check session "${sessionId}" for this repository`,
      );
    case "no-rules":
      throw new AbideError("RUBRIC_MISSING", "no readable rubric to rebase onto");
    default:
      return assertNever(result);
  }
};
