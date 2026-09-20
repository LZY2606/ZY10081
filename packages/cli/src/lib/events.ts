import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { eventSchema, type AbideEvent } from "@coldtea/abide-schema";
import { abideDir, eventsPath } from "./paths.js";
import { writeRegularFile } from "./regularFile.js";

/** Best effort. The log must never take the hook down with it, or hold it. */
export const appendEvent = (root: string, event: AbideEvent): void => {
  try {
    appendLine(root, event);
  } catch {
    // nothing to do: logging is optional
  }
};

const appendLine = (root: string, event: AbideEvent): void => {
  mkdirSync(abideDir(root), { recursive: true });
  writeRegularFile(eventsPath(root), `${JSON.stringify(event)}\n`, { use: "append" });
};

const eventIdOf = (event: AbideEvent): string | undefined =>
  "eventId" in event && typeof event.eventId === "string" ? event.eventId : undefined;

export const readEventsRaw = (root: string): string => {
  try {
    return readFileSync(eventsPath(root), "utf8");
  } catch {
    return "";
  }
};

const hasCommittedId = (root: string, eventId: string): boolean =>
  readEventsRaw(root).includes(`"eventId":"${eventId}"`);

/**
 * Appends an event that carries a check-session event id at most once. The
 * check is against the log itself, so a process that died after the append
 * but before publishing its result cannot append a second copy on retry: the
 * audit ends with the one verdict the id names. False means the append did
 * not complete, so the caller withholds the result and leaves the event to be
 * taken over rather than leaving half an audit.
 */
export const appendEventOnce = (root: string, event: AbideEvent): boolean => {
  const eventId = eventIdOf(event);
  if (eventId === undefined) {
    try {
      appendLine(root, event);
      return true;
    } catch {
      return false;
    }
  }
  if (hasCommittedId(root, eventId)) return true;
  const file = eventsPath(root);
  const lock = `${file}.lock`;
  let fd: number | undefined;
  try {
    mkdirSync(abideDir(root), { recursive: true });
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    if (hasCommittedId(root, eventId)) return true;
    if (!writeRegularFile(file, `${JSON.stringify(event)}\n`, { use: "append" })) return false;
    return true;
  } catch {
    return hasCommittedId(root, eventId);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      try {
        rmSync(lock, { force: true });
      } catch {
        // a stale lock only serialises, never blocks correctness
      }
    }
  }
};

export const readEvents = (root: string): AbideEvent[] => {
  const events: AbideEvent[] = [];
  for (const line of readEventsRaw(root).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // skip a torn line
    }
  }
  return events;
};
