export type Failure = {
  ok: false;
  code: string;
  exit_code: number;
  message: string;
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
  NOTHING_SKIPPED: 0,
  SOME_SKIPPED: 1,
  BAD_ARGUMENTS: 2,
  NOT_READY: 3,
  OUR_BUG: 10,
} as const;
