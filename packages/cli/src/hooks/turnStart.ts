import path from "node:path";
import { turnIdOf, turnStartInputSchema, type HookOutput } from "@coldtea/abide-schema";
import { TURN_START_TIMEOUT_MS } from "../lib/constants.js";
import { isGitRepo, snapshotTree } from "../lib/git.js";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot } from "../lib/paths.js";
import { clearTurn, markBaseline, turnDir, writeBaseline, writePrompt } from "../lib/session.js";
import { ensureSession } from "../lib/checkSession.js";

/**
 * The turn is about to begin: remember what the working tree looks like now,
 * so the Stop check can diff the whole turn, whichever tool made the changes.
 * This is also where the check session is frozen: base tree, rule
 * fingerprint, scope and known file versions. Prints nothing: on this event
 * plain stdout would become context.
 */
export const handleTurnStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = turnStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  const turnId = turnIdOf(input);
  const dir = turnDir(input.session_id, turnId);
  // Without a turn id every turn shares one directory, so the last turn's
  // records go before this one's start.
  if (turnId === undefined) clearTurn(dir);
  if (input.prompt !== undefined) writePrompt(dir, input.prompt);

  const loaded = loadRules(root);
  const git = isGitRepo(root);

  // Written before the attempt: a hook that dies mid-snapshot leaves "pending"
  // behind, and the Stop check reads that as a turn it cannot see whole.
  let baseTree: string | null = null;
  if (git) {
    markBaseline(dir, "pending");
    const tree = snapshotTree(root, path.join(dir, "index"), TURN_START_TIMEOUT_MS);
    if (tree === undefined) {
      markBaseline(dir, "failed");
      return { kind: "silent" };
    }
    writeBaseline(dir, tree);
    markBaseline(dir, "ok");
    baseTree = tree;
  }

  if (loaded.rules.length > 0) {
    ensureSession({
      sessionId: input.session_id,
      root,
      rules: loaded.rules,
      thresholds: loaded.thresholds,
      projectSources: loaded.project?.sources ?? [],
      globalSources: loaded.global?.sources ?? [],
      ...(baseTree === null ? {} : { baseTree }),
    });
  }
  return { kind: "silent" };
};
