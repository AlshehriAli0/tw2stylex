import type { Fix } from "./skip.ts";

const wanted = (): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY && process.env.TERM !== "dumb";
};

const ON = wanted();

const paint =
  (open: number, close: number) =>
  (text: string): string =>
    ON ? `\u001B[${open}m${text}\u001B[${close}m` : text;

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);
export const blue = paint(34, 39);
export const magenta = paint(35, 39);
export const cyan = paint(36, 39);

export const FIX_COLOR: Record<Fix, (text: string) => string> = {
  safe: green,
  "check-first": yellow,
  "needs-lookup": blue,
  unknown: magenta,
};
