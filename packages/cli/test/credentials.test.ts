import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findCredentials,
  parseEnvFile,
  projectEnvPath,
  saveKey,
  upsertEnvLine,
  userEnvPath,
} from "../src/lib/credentials.js";

let home: string;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  process.env.ABIDE_HOME_DIR = home;
  for (const name of ["TYPESAFE_AI_API_KEY", "AI_GATEWAY_API_KEY"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  delete process.env.ABIDE_HOME_DIR;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("credentials", () => {
  it("reads only the two abide keys out of an env file", () => {
    const vars = parseEnvFile(
      "# comment\nexport TYPESAFE_AI_API_KEY=\"abc\"\nOTHER=1\nAI_GATEWAY_API_KEY='g'\nBROKEN\n",
    );
    expect([...vars.entries()]).toEqual([
      ["TYPESAFE_AI_API_KEY", "abc"],
      ["AI_GATEWAY_API_KEY", "g"],
    ]);
  });

  it("looks in the environment, then the repo, then the user file, and prefers TypeSafe", () => {
    expect(findCredentials(root)).toEqual({ kind: "none" });
    saveKey(userEnvPath(), "AI_GATEWAY_API_KEY", "user-gateway");
    expect(findCredentials(root)).toMatchObject({ kind: "gateway", key: "user-gateway" });
    writeFileSync(path.join(root, ".env"), "TYPESAFE_AI_API_KEY=repo\n");
    expect(findCredentials(root)).toMatchObject({ kind: "typesafe", key: "repo", from: ".env" });
    writeFileSync(path.join(root, ".env.local"), "AI_GATEWAY_API_KEY=local\n");
    expect(findCredentials(root)).toMatchObject({
      kind: "gateway",
      key: "local",
      from: ".env.local",
    });
    process.env.TYPESAFE_AI_API_KEY = "env";
    expect(findCredentials(root)).toMatchObject({ kind: "typesafe", key: "env" });
  });

  it("writes the user file owner-only and keeps the other key", () => {
    saveKey(userEnvPath(), "TYPESAFE_AI_API_KEY", "t");
    saveKey(userEnvPath(), "AI_GATEWAY_API_KEY", "g");
    const file = userEnvPath();
    expect(readFileSync(file, "utf8")).toBe("TYPESAFE_AI_API_KEY=t\nAI_GATEWAY_API_KEY=g\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces only its own line in a repo .env.local and leaves the rest untouched", () => {
    const file = projectEnvPath(root);
    writeFileSync(
      file,
      "# theirs\nDATABASE_URL=postgres://x\nexport TYPESAFE_AI_API_KEY = old\nOTHER=1",
    );
    saveKey(file, "TYPESAFE_AI_API_KEY", "new");
    expect(readFileSync(file, "utf8")).toBe(
      "# theirs\nDATABASE_URL=postgres://x\nTYPESAFE_AI_API_KEY=new\nOTHER=1\n",
    );
    expect(findCredentials(root)).toMatchObject({
      kind: "typesafe",
      key: "new",
      from: ".env.local",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked .env.local and leaves its target alone", () => {
    const target = path.join(root, "tracked.env");
    writeFileSync(target, "SHARED=1\n");
    symlinkSync(target, projectEnvPath(root));
    expect(() => saveKey(projectEnvPath(root), "TYPESAFE_AI_API_KEY", "k")).toThrow(
      "is not a plain file",
    );
    expect(readFileSync(target, "utf8")).toBe("SHARED=1\n");
    expect(readFileSync(projectEnvPath(root), "utf8")).toBe("SHARED=1\n");
  });

  it("refuses a directory at the path", () => {
    mkdirSync(projectEnvPath(root));
    expect(() => saveKey(projectEnvPath(root), "TYPESAFE_AI_API_KEY", "k")).toThrow(
      "is not a plain file",
    );
  });

  it("never truncates an existing file it could not read", () => {
    const file = projectEnvPath(root);
    writeFileSync(file, "THEIRS=1\n");
    chmodSync(file, 0o200);
    expect(() => saveKey(file, "TYPESAFE_AI_API_KEY", "k")).toThrow("could not be read");
    chmodSync(file, 0o600);
    expect(readFileSync(file, "utf8")).toBe("THEIRS=1\n");
  });

  it("appends to a file that has no trailing newline and starts an empty one", () => {
    expect(upsertEnvLine("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvLine("", "B", "2")).toBe("B=2\n");
    expect(upsertEnvLine("AB=1\n", "A", "2")).toBe("AB=1\nA=2\n");
  });
});
