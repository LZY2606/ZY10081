import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readSecret } from "../src/lib/secret.js";

/** A stdin as Ink leaves it after a view: not referenced, so nothing alone keeps the process alive. */
class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  referenced = false;
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
  ref(): this {
    this.referenced = true;
    return this;
  }
}

/** stdin as `abide login < key-file` gives it: a plain file stream, with no ref at all. */
class FakeFile extends PassThrough {
  isTTY = false;
  isRaw = false;
  setRawMode(): this {
    throw new Error("a file has no raw mode");
  }
}

describe("readSecret", () => {
  it("reads a redirected file without touching raw mode or ref", async () => {
    const input = new FakeFile();
    const pending = readSecret("Key: ", { input, output: { write: vi.fn() } });
    input.write("from-a-file\n");
    await expect(pending).resolves.toBe("from-a-file");
  });

  it("references stdin before waiting, so a key can still be typed after an Ink view has left", async () => {
    const input = new FakeTty();
    const output = { write: vi.fn() };
    const pending = readSecret("Key: ", { input, output });
    expect(input.referenced).toBe(true);
    expect(input.isRaw).toBe(true);
    input.write("abcd\u007f\r");
    await expect(pending).resolves.toBe("abc");
    expect(input.isRaw).toBe(false);
    expect(output.write).toHaveBeenCalledWith("Key: ");
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining("abc"));
  });
});
