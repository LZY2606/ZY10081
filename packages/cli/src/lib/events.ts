import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eventSchema, type AbideEvent } from "@coldtea/abide-schema";
import { abideDir, eventsPath } from "./paths.js";
import { writeRegularFile } from "./regularFile.js";
import { eventMarker } from "./checkSession.js";

/** Best effort. The log must never take the hook down with it, or hold it. */
export const appendEvent = (root: string, event: AbideEvent): boolean => {
  try {
    mkdirSync(abideDir(root), { recursive: true });
    return writeRegularFile(eventsPath(root), `${JSON.stringify(event)}\n`, { use: "append" });
  } catch {
    // nothing to do: logging is optional
    return false;
  }
};

/**
 * Appends an audit event at most once per delivered hook event. The marker is
 * created first in the owner-only session dir; a retried or parallel
 * delivery that sees it writes nothing, so one event id means one jsonl line.
 */
export const appendEventOnce = (
  root: string,
  sessionId: string,
  generation: number,
  eventId: string,
  event: AbideEvent,
): boolean => {
  try {
    mkdirSync(path.dirname(eventMarker(sessionId, generation, eventId)), {
      recursive: true,
      mode: 0o700,
    });
  } catch {
    return appendEvent(root, event);
  }
  try {
    writeFileSync(eventMarker(sessionId, generation, eventId), "1", { flag: "wx", mode: 0o600 });
  } catch {
    return false;
  }
  return appendEvent(root, event);
};

export const readEvents = (root: string): AbideEvent[] => {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(root), "utf8");
  } catch {
    return [];
  }
  const events: AbideEvent[] = [];
  for (const line of raw.split("\n")) {
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
