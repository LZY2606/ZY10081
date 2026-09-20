import { createHash } from "node:crypto";

/** Rule ids are kebab-case slugs. The compiling agent writes them; the schema enforces the format. */
export const RULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const createRuleId = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "rule";
};

/** Source hash stored in the rubric header: sha256 of the file's bytes, hex. */
export const createSourceSha = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** Git's blob id, so content on disk, in a tree and in a hook payload compare equal. */
export const createBlobId = (content: string | Uint8Array): string => {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

/** Key for the per-turn block counter: one rule on one file. */
export const createBlockKey = (ruleId: string, relativePath: string): string =>
  `${ruleId}@${relativePath}`;

/**
 * Fingerprint of the compiled rules a session was opened against. One owner
 * for the format: every drift check and report compares these strings, never
 * a hand-rolled hash. Order-dependent: rules are a compiled list, not a set.
 */
export type FingerprintInput = {
  rules: readonly {
    id: string;
    text: string;
    source: { path: string; line?: number };
    scope?: readonly string[];
    when?: string;
    check: unknown;
    status: string;
    origin?: string;
  }[];
  thresholds: unknown;
  sources: readonly { path: string; sha?: string }[];
};

export const createRulesFingerprint = (input: FingerprintInput): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

/**
 * Stable identity of one delivered hook event. The same session and event id
 * retried, or delivered by two host adapters at once, hashes equal and lands
 * once. `attempt` separates a genuine second Stop after a repair from a retry.
 */
export const createHookEventId = (parts: {
  sessionId: string;
  event: string;
  turnId?: string;
  toolUseId?: string;
  attempt?: number;
}): string => {
  const basis = [
    parts.sessionId,
    parts.event,
    parts.turnId ?? "",
    parts.toolUseId ?? "",
    String(parts.attempt ?? 0),
  ].join("\u0000");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
};
