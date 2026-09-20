import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AbideEvent } from "@coldtea/abide-schema";
import { appendEvent, appendEventOnce, readEvents } from "../src/lib/events.js";

const event = { kind: "skip", at: "now", phase: "edit", reason: "test" } as const;

describe("the event log", () => {
  it("appends and reads back", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-events-"));
    appendEvent(root, event);
    appendEvent(root, event);
    expect(readEvents(root)).toEqual([event, event]);
    expect(
      readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8").split("\n"),
    ).toHaveLength(3);
  });

  it(
    "refuses a FIFO in the log's place instead of waiting on its reader",
    { timeout: 3_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "abide-events-"));
      mkdirSync(path.join(root, ".abide"));
      execSync(`mkfifo "${path.join(root, ".abide", "events.jsonl")}"`);
      appendEvent(root, event);
    },
  );
});

const checkEvent = (id: string): AbideEvent =>
  ({
    kind: "check",
    at: "now",
    phase: "edit",
    sessionId: "s",
    eventId: id,
    files: ["a.ts"],
    rules: 1,
    latencyMs: 1,
    verdicts: [],
    blocked: false,
  }) as const;

describe("exact-once audit commits", () => {
  it("commits an event id once even across competing appenders", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-events-once-"));
    const results = [
      appendEventOnce(root, checkEvent("dup-1")),
      appendEventOnce(root, checkEvent("dup-1")),
    ];
    expect(results).toEqual([true, true]);
    const lines = readEvents(root).filter((e) => "eventId" in e && e.eventId === "dup-1");
    expect(lines).toHaveLength(1);
  });

  it("still appends events that carry no session event id every time", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-events-plain-"));
    appendEventOnce(root, event);
    appendEventOnce(root, event);
    expect(readEvents(root)).toHaveLength(2);
  });
});
