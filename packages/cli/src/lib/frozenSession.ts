import { ensureSession, readSnapshot, type OpenedSession } from "./checkSession.js";
import { loadRules } from "./loadRules.js";

/**
 * Every hook reads rules through here. A session already open on disk is
 * restored as it was frozen; only a session with no snapshot reads the
 * rubrics, and that read is the one frozen for the rest of the session's life.
 */
export const openFrozenSession = (sessionId: string, root: string): OpenedSession | undefined => {
  const found = readSnapshot(sessionId);
  if (found !== undefined) {
    return ensureSession({
      sessionId,
      root,
      rules: found.rules as unknown as Parameters<typeof ensureSession>[0]["rules"],
      thresholds: found.thresholds,
      projectSources: found.sources
        .filter((source) => source.origin === "project")
        .map((source) => ({ path: source.path, sha: source.sha, scope: source.scope })),
      globalSources: found.sources
        .filter((source) => source.origin === "global")
        .map((source) => ({ path: source.path, sha: source.sha, scope: source.scope })),
    });
  }
  const loaded = loadRules(root);
  return ensureSession({
    sessionId,
    root,
    rules: loaded.rules,
    thresholds: loaded.thresholds,
    projectSources: loaded.project?.sources ?? [],
    globalSources: loaded.global?.sources ?? [],
  });
};
