import path from "node:path";
import { Text } from "ink";
import { createElement, type ReactElement } from "react";
import { AbideError } from "@coldtea/abide-schema";
import { isIgnored } from "../lib/git.js";
import { readSecret } from "../lib/secret.js";
import { findRepoRoot } from "../lib/paths.js";
import { Callout } from "../ui/components/Callout.js";
import { showPicker, showStatic } from "../ui/render.js";
import type { PickerItem } from "../ui/components/Picker.js";
import { GATEWAY_KEY_ENV, TYPESAFE_KEY_ENV } from "../lib/constants.js";
import { projectEnvPath, saveKey, userEnvPath } from "../lib/credentials.js";

type Provider = { name: string; prompt: string };

type Place = { kind: "user" } | { kind: "project"; root: string };

const TYPESAFE: PickerItem<Provider> = {
  value: { name: TYPESAFE_KEY_ENV, prompt: "TypeSafe API key: " },
  label: "TypeSafe API key",
  hint: "from typesafe.ai",
};

const GATEWAY: PickerItem<Provider> = {
  value: { name: GATEWAY_KEY_ENV, prompt: "Vercel AI Gateway key: " },
  label: "Vercel AI Gateway key",
  hint: "a key you already have",
};

/** On a pipe there is no menu, so the first item wins. */
const ask = async <T>(title: string, items: readonly PickerItem<T>[]): Promise<T> => {
  const first = items[0];
  if (first === undefined) throw new AbideError("NO_API_KEY", "nothing to choose from");
  if (!process.stdin.isTTY) return first.value;
  const chosen = await showPicker(title, items);
  if (chosen === undefined) throw new AbideError("NO_API_KEY", "nothing was chosen");
  return chosen.value;
};

const choosePlace = (root: string): Promise<Place> =>
  ask<Place>("Where should it live?", [
    { value: { kind: "user" }, label: "Every repo on this machine", hint: "~/.abide/.env" },
    { value: { kind: "project", root }, label: "This repo only", hint: ".env.local at the root" },
  ]);

const envFile = (place: Place): string =>
  place.kind === "user" ? userEnvPath() : projectEnvPath(place.root);

export const leakWarning = (place: Place): ReactElement | null => {
  if (place.kind === "user") return null;
  const name = path.basename(projectEnvPath(place.root));
  if (isIgnored(place.root, name)) return null;
  return Callout({
    tone: "warn",
    title: `${name} is not ignored by git`,
    children: createElement(
      Text,
      null,
      `Add ${name} to .gitignore before you commit, or the key goes with it.`,
    ),
  });
};

/** Never a flag: a flag lands in shell history and CI logs. */
export const runLogin = async (): Promise<number> => {
  const provider = await ask("Which key do you have?", [TYPESAFE, GATEWAY]);
  const place = await choosePlace(findRepoRoot(process.cwd()));
  const key = await readSecret(provider.prompt);
  if (key === "") throw new AbideError("NO_API_KEY", "nothing was entered");
  const file = saveKey(envFile(place), provider.name, key);
  await showStatic(
    Callout({
      tone: "ok",
      title: `${provider.name} saved to ${file} (owner-only). Run abide init next.`,
    }),
  );
  const warning = leakWarning(place);
  if (warning !== null) await showStatic(warning);
  return 0;
};
