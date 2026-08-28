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

/**
 * A class string converts the same way wherever it appears, and real codebases repeat themselves:
 * `size-4` and `space-y-2` show up in hundreds of files. The style key is not part of the answer,
 * so one canonical name verifies for every caller and the name is stamped back on the way out.
 */
const CANONICAL = "s";
const memos = new WeakMap<DesignSystem, Map<string, Converted>>();

const memoFor = (ds: DesignSystem): Map<string, Converted> => {
  const found = memos.get(ds);
  if (found) return found;
  const fresh = new Map<string, Converted>();
  memos.set(ds, fresh);
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
      hint: "This is a tw2sx bug. Convert this one by hand and please report it.",
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
        hint: "See `mismatches` in the JSON report. This is a tw2sx bug; convert this one by hand.",
      },
    ],
    checked.mismatches,
  );
};

/** Everything a class string needs before StyleX has been asked whether it compiles. */
type Pending = { key: string; resolved: ResolvedClasses; style: Style };

const prepare = (ds: DesignSystem, classes: string[]): Converted | Pending => {
  const resolved = resolveClasses(ds, classes);
  if (resolved.skips.length > 0) return nothing(resolved.skips);
  if (resolved.declarations.size === 0) return nothing([]);
  return { key: classes.join(" "), resolved, style: toStyle(resolved) };
};

const isPending = (v: Converted | Pending): v is Pending => "resolved" in v;

type Compiled = { rules: CompiledRule[] } | { error: string };

/**
 * StyleX compiles a declaration into its own atomic class regardless of what sits beside it, so
 * the run only has to ask about each distinct declaration once. A codebase repeats declarations
 * far more than it repeats whole styles, and asking about the few that are new is several times
 * cheaper than recompiling every style that mentions them.
 *
 * A declaration StyleX rejects takes its whole call down, so a failed batch halves until the
 * culprit is alone. On a healthy codebase that never happens and the run costs one compile.
 */
const compileDeclarations = (
  keys: string[],
  styleFor: Map<string, Style>,
  into: Map<string, Compiled>,
): void => {
  if (keys.length === 0) return;

  const batch: Record<string, Style> = {};
  keys.forEach((key, i) => {
    const style = styleFor.get(key);
    if (style) batch[`${CANONICAL}${i}`] = style;
  });

  const compiled = compileMany(batch);
  if (!("error" in compiled)) {
    keys.forEach((key, i) =>
      into.set(key, { rules: compiled.rules.get(`${CANONICAL}${i}`) ?? [] }),
    );
    return;
  }

  if (keys.length === 1) {
    const only = keys[0];
    if (only !== undefined) into.set(only, { error: compiled.error });
    return;
  }

  const half = Math.floor(keys.length / 2);
  compileDeclarations(keys.slice(0, half), styleFor, into);
  compileDeclarations(keys.slice(half), styleFor, into);
};

const verifyBatch = (memo: Map<string, Converted>, batch: Pending[]): void => {
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
  compileDeclarations(order, styleFor, compiled);

  batch.forEach((pending, i) => {
    const keys = perStyle[i] ?? [];
    const broken = keys.map(k => compiled.get(k)).find(c => c && "error" in c);
    if (broken && "error" in broken) {
      memo.set(pending.key, compileFailed(broken.error));
      return;
    }

    const seen = new Set<string>();
    const rules: CompiledRule[] = [];
    for (const key of keys) {
      const entry = compiled.get(key);
      if (!entry || "error" in entry) continue;
      for (const rule of entry.rules)
        if (!seen.has(rule.className)) {
          seen.add(rule.className);
          rules.push(rule);
        }
    }
    memo.set(
      pending.key,
      fromVerdict(pending.style, compareStyle(CANONICAL, pending.resolved, rules)),
    );
  });
};

/**
 * Resolve and verify every class string the run will ask about, before it asks. Without this each
 * `convert` compiles alone; with it they share one compile and every later call is a memo hit.
 */
export const warmUp = (ds: DesignSystem, classStrings: Iterable<string[]>): void => {
  const memo = memoFor(ds);
  const seen = new Set(memo.keys());
  const batch: Pending[] = [];
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
    ? fromVerdict(prepared.style, checkStyle(CANONICAL, prepared.resolved, prepared.style))
    : prepared;

  memo.set(key, result);
  return named(result, name);
};
