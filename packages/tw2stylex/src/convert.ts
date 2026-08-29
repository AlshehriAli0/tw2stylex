import {
  checkStyle,
  compareStyle,
  compileMany,
  type CompiledRule,
  type Mismatch,
  type VerifyResult,
} from "./check.ts";
import { resolveClasses, type ResolvedClasses } from "./classes-to-css.ts";
import { asStyle, declarationKey, declarationsOf, toStyle, type Style } from "./css-to-stylex.ts";
import type { Skip } from "./skip.ts";
import type { DesignSystem } from "./tailwind.ts";

export type Converted =
  | { style: Style; rules: number; skips: []; mismatches: [] }
  | { style?: undefined; rules: 0; skips: Skip[]; mismatches: Mismatch[] };

const nothing = (skips: Skip[], mismatches: Mismatch[] = []): Converted => ({
  rules: 0,
  skips,
  mismatches,
});

const lastLine = (message: string): string => message.split("\n").pop()?.trim() ?? message;

const SHARED_KEY = "s";
const convertedByClasses = new WeakMap<DesignSystem, Map<string, Converted>>();

const memoFor = (ds: DesignSystem): Map<string, Converted> => {
  const found = convertedByClasses.get(ds);
  if (found) return found;
  const fresh = new Map<string, Converted>();
  convertedByClasses.set(ds, fresh);
  return fresh;
};

const named = (result: Converted, name: string): Converted =>
  result.mismatches.length === 0
    ? result
    : nothing(
        result.skips,
        result.mismatches.map(m => ({ ...m, styleName: name })),
      );

const compileFailed = (message: string): Converted =>
  nothing([
    {
      reason: "stylex-compile-error",
      detail: `The StyleX we generated does not compile: ${lastLine(message)}`,
      hint: "This is a tw2stylex bug. Convert this one by hand and please report it.",
    },
  ]);

const fromVerdict = (style: Style, checked: VerifyResult): Converted => {
  if (checked.ok) return { style, rules: checked.rules.length, skips: [], mismatches: [] };
  if (checked.kind === "compile-error") return compileFailed(checked.message);
  return nothing(
    [
      {
        reason: "lost-condition",
        detail: `The StyleX we generated differs from Tailwind in ${checked.mismatches.length} place(s).`,
        hint: "See `mismatches` in the JSON report. This is a tw2stylex bug; convert this one by hand.",
      },
    ],
    checked.mismatches,
  );
};

type Unverified = { key: string; resolved: ResolvedClasses; style: Style };

const prepare = (ds: DesignSystem, classes: string[]): Converted | Unverified => {
  const resolved = resolveClasses(ds, classes);
  if (resolved.skips.length > 0) return nothing(resolved.skips);
  if (resolved.declarations.size === 0) return nothing([]);
  return { key: classes.join(" "), resolved, style: toStyle(resolved) };
};

const isPending = (v: Converted | Unverified): v is Unverified => "resolved" in v;

type Compiled = { rules: CompiledRule[] } | { error: string };

const compileDeclarationsHalvingOnFailure = (
  keys: string[],
  styleFor: Map<string, Style>,
  into: Map<string, Compiled>,
): void => {
  if (keys.length === 0) return;

  const batch: Record<string, Style> = {};
  keys.forEach((key, i) => {
    const style = styleFor.get(key);
    if (style) batch[`${SHARED_KEY}${i}`] = style;
  });

  const compiled = compileMany(batch);
  if (!("error" in compiled)) {
    keys.forEach((key, i) =>
      into.set(key, { rules: compiled.rules.get(`${SHARED_KEY}${i}`) ?? [] }),
    );
    return;
  }

  if (keys.length === 1) {
    const only = keys[0];
    if (only !== undefined) into.set(only, { error: compiled.error });
    return;
  }

  const half = Math.floor(keys.length / 2);
  compileDeclarationsHalvingOnFailure(keys.slice(0, half), styleFor, into);
  compileDeclarationsHalvingOnFailure(keys.slice(half), styleFor, into);
};

const verifyBatch = (memo: Map<string, Converted>, batch: Unverified[]): void => {
  if (batch.length === 0) return;

  const styleFor = new Map<string, Style>();
  const order: string[] = [];
  const perStyle = batch.map(({ style }) =>
    declarationsOf(style).map(declaration => {
      const key = declarationKey(declaration);
      if (!styleFor.has(key)) {
        styleFor.set(key, asStyle(declaration));
        order.push(key);
      }
      return key;
    }),
  );

  const compiled = new Map<string, Compiled>();
  compileDeclarationsHalvingOnFailure(order, styleFor, compiled);

  batch.forEach((pending, i) => {
    const keys = perStyle[i] ?? [];
    const failure = firstFailure(keys, compiled);
    memo.set(
      pending.key,
      failure === undefined
        ? fromVerdict(
            pending.style,
            compareStyle(SHARED_KEY, pending.resolved, rulesFor(keys, compiled)),
          )
        : compileFailed(failure),
    );
  });
};

const firstFailure = (keys: string[], compiled: Map<string, Compiled>): string | undefined => {
  for (const key of keys) {
    const entry = compiled.get(key);
    if (entry && "error" in entry) return entry.error;
  }
  return undefined;
};

const rulesFor = (keys: string[], compiled: Map<string, Compiled>): CompiledRule[] => {
  const byClassName = new Map<string, CompiledRule>();
  for (const key of keys) {
    const entry = compiled.get(key);
    if (entry && "rules" in entry)
      for (const rule of entry.rules) byClassName.set(rule.className, rule);
  }
  return [...byClassName.values()];
};

export const warmUp = (ds: DesignSystem, classStrings: Iterable<string[]>): void => {
  const memo = memoFor(ds);
  const seen = new Set(memo.keys());
  const batch: Unverified[] = [];
  for (const classes of classStrings) {
    const key = classes.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const prepared = prepare(ds, classes);
    if (isPending(prepared)) batch.push(prepared);
    else memo.set(key, prepared);
  }

  verifyBatch(memo, batch);
};

export const convert = (ds: DesignSystem, name: string, classes: string[]): Converted => {
  const memo = memoFor(ds);
  const key = classes.join(" ");
  const hit = memo.get(key);
  if (hit) return named(hit, name);

  const prepared = prepare(ds, classes);
  const result = isPending(prepared)
    ? fromVerdict(prepared.style, checkStyle(SHARED_KEY, prepared.resolved, prepared.style))
    : prepared;

  memo.set(key, result);
  return named(result, name);
};
