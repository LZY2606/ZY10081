export type AbideErrorCode =
  | "NO_API_KEY"
  | "KEY_FILE_UNWRITABLE"
  | "NO_INSTRUCTION_FILES"
  | "RUBRIC_INVALID"
  | "RUBRIC_MISSING"
  | "SETTINGS_INVALID"
  | "HOST_UNKNOWN"
  | "HOST_NOT_FOUND"
  | "GIT_UNAVAILABLE"
  | "CLAUDE_UNAVAILABLE"
  | "CHECK_TIMEOUT"
  | "CHECK_FAILED"
  | "SESSION_CONFLICT"
  | "SESSION_NOT_FOUND";

export class AbideError extends Error {
  readonly code: AbideErrorCode;

  constructor(code: AbideErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AbideError";
    this.code = code;
  }
}

export const isAbideError = (value: unknown): value is AbideError => value instanceof AbideError;
