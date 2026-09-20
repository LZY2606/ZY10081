import { createHookEventId, type HookOutput } from "@coldtea/abide-schema";
import { handlePostToolUse } from "./hooks/postToolUse.js";
import { handleSessionStart } from "./hooks/sessionStart.js";
import { handleStop } from "./hooks/stop.js";
import { handleTurnStart } from "./hooks/turnStart.js";
import { liveSessionId, readSnapshot, runOnce } from "./lib/checkSession.js";
import { runHook, type HookName } from "./lib/hookRunner.js";
import { stopCheckCount, turnDir } from "./lib/session.js";

type HookInput = {
  session_id?: unknown;
  prompt_id?: unknown;
  turn_id?: unknown;
  tool_use_id?: unknown;
  stop_hook_active?: unknown;
};

const eventOf = (name: HookName): string => {
  switch (name) {
    case "session-start":
      return "SessionStart";
    case "turn-start":
      return "UserPromptSubmit";
    case "post-tool-use":
      return "PostToolUse";
    case "stop":
      return "Stop";
    default:
      return name satisfies never;
  }
};

/**
 * Same session and event id retried, or two host adapters delivering at once,
 * run the handler exactly once: the loser replays the winner's exact output.
 * Inputs that name no session (garbage, old single-file callers) pass
 * straight through.
 */
const dedupeKey = (name: HookName, raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const input = raw as HookInput;
  if (typeof input.session_id !== "string" || input.session_id === "") return undefined;
  const turnId =
    typeof input.prompt_id === "string"
      ? input.prompt_id
      : typeof input.turn_id === "string"
        ? input.turn_id
        : undefined;
  const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
  // How many Stop checks already ran this turn is the attempt number;
  // stop_hook_active says a previous stop is showing, it is not a new attempt.
  const attempt = name === "stop" ? stopCheckCount(turnDir(input.session_id, turnId)) : 0;
  return createHookEventId({
    sessionId: input.session_id,
    event: eventOf(name),
    turnId,
    toolUseId,
    attempt,
  });
};

const handler = (name: HookName): ((raw: unknown) => Promise<HookOutput>) => {
  const base = (raw: unknown): Promise<HookOutput> | HookOutput => {
    switch (name) {
      case "session-start":
        return handleSessionStart(raw);
      case "turn-start":
        return handleTurnStart(raw);
      case "post-tool-use":
        return handlePostToolUse(raw);
      case "stop":
        return handleStop(raw);
      default:
        return name satisfies never;
    }
  };
  return async (raw: unknown): Promise<HookOutput> => {
    const sessionId =
      typeof raw === "object" && raw !== null && typeof (raw as HookInput).session_id === "string"
        ? ((raw as HookInput).session_id as string)
        : undefined;
    const eventId = dedupeKey(name, raw);
    if (sessionId === undefined || eventId === undefined || readSnapshot(sessionId) === undefined) {
      return base(raw);
    }
    // A late delivery for a rebased generation dedupes against the live one.
    const liveId = liveSessionId(sessionId);
    return runOnce({
      sessionId: liveId,
      eventId,
      work: () => base(raw),
      measureMs: () => 0,
    });
  };
};

const name = process.argv[2] as HookName | undefined;
switch (name) {
  case "session-start":
    await runHook("session-start", handler("session-start"), 8_000);
    break;
  case "turn-start":
    await runHook("turn-start", handler("turn-start"), 8_000);
    break;
  case "post-tool-use":
    await runHook("post-tool-use", handler("post-tool-use"), 18_000);
    break;
  case "stop":
    await runHook("stop", handler("stop"), 28_000);
    break;
  default:
    process.exit(0);
}
