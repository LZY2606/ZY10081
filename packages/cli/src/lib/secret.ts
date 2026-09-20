/** Enough of stdin for a test to hand in its own stream. */
export type SecretInput = {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  /** A redirected file has no ref. */
  ref?(): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
};

type SecretIo = { input: SecretInput; output: { write(text: string): unknown } };

const processIo = (): SecretIo => ({ input: process.stdin, output: process.stderr });

/** Reads one line without echoing it, so the key never lands in a terminal scrollback. */
export const readSecret = (prompt: string, io: SecretIo = processIo()): Promise<string> =>
  new Promise((resolve) => {
    const { input, output } = io;
    output.write(prompt);
    const wasRaw = input.isTTY ? input.isRaw : false;
    if (input.isTTY) input.setRawMode(true);
    input.setEncoding("utf8");

    if (input.isTTY) input.ref?.();
    input.resume();

    let value = "";
    const done = (): void => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      resolve(value.trim());
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          done();
          process.exit(1);
        }
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          done();
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    input.on("data", onData);
  });
