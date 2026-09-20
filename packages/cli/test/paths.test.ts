import { describe, expect, it } from "vitest";
import { isExcludedPath, isSecretFile } from "../src/lib/paths.js";

describe("paths no check may see", () => {
  it("names the files that hold secrets by convention", () => {
    for (const p of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      ".envrc",
      "certs/server.key",
      "id.pem",
    ]) {
      expect(isSecretFile(p), p).toBe(true);
    }
    for (const p of [
      "src/env.ts",
      ".environment",
      "env/.envfile.ts",
      "keys.ts",
      "src/keyboard.ts",
    ]) {
      expect(isSecretFile(p), p).toBe(false);
    }
    expect(isExcludedPath(".abide/rubric.json")).toBe(true);
    expect(isExcludedPath("src/a.ts")).toBe(false);
  });
});
