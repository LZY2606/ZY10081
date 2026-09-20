import { parseArgs } from "node:util";
import { HOSTS } from "@coldtea/abide-schema";
import { hostLabel, parseHost, uninstallHost } from "../lib/hosts.js";
import { findRepoRoot } from "../lib/paths.js";
import { Callout } from "../ui/components/Callout.js";
import { showStatic } from "../ui/render.js";

export const runUninstall = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const hosts = positionals.length > 0 ? [...new Set(positionals.map(parseHost))] : [...HOSTS];
  const removed = hosts.map((host) => ({
    host,
    count: uninstallHost(host, root, values.project),
  }));
  const touched = removed.filter((r) => r.count > 0);
  await showStatic(
    touched.length === 0
      ? Callout({
          tone: "muted",
          title: "No abide entries found for " + hosts.map(hostLabel).join(", "),
        })
      : Callout({
          tone: "ok",
          title: `Removed abide from ${touched.map((r) => hostLabel(r.host)).join(", ")}. Your rubric files are untouched.`,
        }),
  );
  return 0;
};
