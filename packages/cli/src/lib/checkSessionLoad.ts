import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CheckSessionSnapshot, KnownFile } from "@coldtea/abide-schema";
import { createBlobId } from "@coldtea/abide-schema";
import { GIT_TIMEOUT_MS } from "./constants.js";
import { globalRubricPath, rubricPath } from "./paths.js";
import { readRubric } from "./rubricFile.js";
import { isGitRepo, snapshotTree } from "./git.js";
import { readFileStarts, turnDir } from "./session.js";
import { relativeToRoot } from "./paths.js";
import { sessionDir, type LoadedInput } from "./checkSession.js";

const gitHead = (root: string): string | undefined => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const head = result.stdout?.trim();
  return result.status === 0 && head ? head : undefined;
};

/**
 * Reads the compiled rubrics, the git base, and the file versions this turn
 * already saw, once, for a fresh snapshot. New files a Write created carry a
 * null origin and would otherwise look like outside drift.
 */
export const loadSessionInput = (
  root: string,
  options: { timeoutMs?: number; sessionId?: string; turnId?: string } = {},
): LoadedInput => {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const projectRead = readRubric(rubricPath(root));
  const globalRead = readRubric(globalRubricPath());
  const project = projectRead.kind === "ok" ? projectRead.rubric : undefined;
  const global = globalRead.kind === "ok" ? globalRead.rubric : undefined;

  const knownFiles: KnownFile[] = [];
  if (options.sessionId !== undefined) {
    for (const start of readFileStarts(turnDir(options.sessionId, options.turnId))) {
      knownFiles.push({
        path: relativeToRoot(root, start.path),
        blob: start.original === null ? null : createBlobId(start.original),
      });
    }
  }

  if (!isGitRepo(root)) return { project, global, knownFiles };
  const head = gitHead(root);
  if (head === undefined) return { project, global, knownFiles };
  const tree = snapshotTree(root, path.join(sessionDir("base"), "index"), timeoutMs);
  return { project, global, head, tree: tree ?? null, knownFiles };
};

/** Rules a hook checks against: always the snapshot's, never a fresh disk read. */
export const sessionRules = (snapshot: CheckSessionSnapshot) => snapshot.rules;
