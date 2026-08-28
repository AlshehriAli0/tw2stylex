/** How the CLI fails, and what it returns to the shell. */

export type Failure = {
  ok: false;
  /** Stable string an agent can branch on, unchanged by message rewording. */
  code: string;
  exit_code: number;
  message: string;
  /** A command the caller can actually run next. */
  hint: string;
};

export const fail = (code: string, exit_code: number, message: string, hint: string): Failure => ({
  ok: false,
  code,
  exit_code,
  message,
  hint,
});

export const EXIT = {
  /** Nothing was skipped. */
  CLEAN: 0,
  /** Ran fine, but some usages were skipped. Not an error. */
  SKIPPED: 1,
  /** Bad arguments. */
  USAGE: 2,
  /** Something had to be true before we could start, and wasn't. */
  PRECONDITION: 3,
  /** Our bug. */
  INTERNAL: 10,
} as const;
