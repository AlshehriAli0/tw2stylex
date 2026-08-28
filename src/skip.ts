/**
 * What a skip is and why it happened.
 *
 * A skip is a usage the tool did not convert. It is normal output, not a failure: Tailwind and
 * StyleX cannot express all the same things, so a partial conversion is the honest result.
 */

/**
 * Why a usage was skipped. Fixed list, so an agent can branch on it and the skill can carry
 * one how-to-fix section per entry.
 */
export const REASONS = [
  "unknown-class", // Tailwind does not recognise it in this project
  "marker-class", // `group` / `peer` - becomes a StyleX marker
  "descendant-selector", // [&_svg]:, [&>*]: - StyleX rejects these outright
  "parent-state", // dark:, in-* - only applies under some parent
  "sibling-state", // group-*/peer-* - needs a marker on another element
  "styles-children", // space-x-*, divide-* - styles children, not this element
  "dropped-shorthand", // background/border/animation - StyleX drops these silently
  "unresolved-variable", // a --tw-* slot with no value and no fallback
  "unsupported-at-rule", // @starting-style and friends
  "dynamic-classes", // the class string is built at runtime
  "variant-function", // a cva()-style function we could not follow to its definition
  "passed-in-classes", // a className prop flows in; converting changes the component's props
  "lost-condition", // the generated StyleX dropped a :hover (or similar) on merge
  "two-style-sources", // element has both className and style
  "important-modifier", // `p-4!` - StyleX has no !important
  "stylex-compile-error", // the StyleX we generated does not compile - our bug
] as const;

export type Reason = (typeof REASONS)[number];

/**
 * How hard the skip is to resolve. Separate question from why it happened, because the agent's
 * next move depends on this and not on the reason.
 */
export const FIXES = ["safe", "check-first", "needs-lookup", "unknown"] as const;

export type Fix = (typeof FIXES)[number];

/** One line each, for `--help` and the report. */
export const FIX_MEANING: Record<Fix, string> = {
  safe: "one right answer, fine to do in bulk",
  "check-first": "a rewrite exists but can change behaviour; read the code first",
  "needs-lookup": "go find something first - a parent element, a child component",
  unknown: "investigate; often not a Tailwind class at all",
};

/** The default fix type per reason. A skip may override it. */
export const DEFAULT_FIX: Record<Reason, Fix> = {
  "unknown-class": "unknown",
  "marker-class": "safe",
  "descendant-selector": "needs-lookup",
  "parent-state": "needs-lookup",
  "sibling-state": "needs-lookup",
  "styles-children": "check-first",
  "dropped-shorthand": "safe",
  "unresolved-variable": "check-first",
  "unsupported-at-rule": "needs-lookup",
  "dynamic-classes": "check-first",
  "variant-function": "safe",
  "passed-in-classes": "check-first",
  "lost-condition": "check-first",
  "two-style-sources": "check-first",
  // Dropping the `!` only works once whatever it was beating is gone - go look.
  "important-modifier": "needs-lookup",
  // Our bug, not the user's. Nothing to batch, nothing to look up.
  "stylex-compile-error": "unknown",
};

/** A usage the tool did not convert. */
export type Skip = {
  reason: Reason;
  /** The specific Tailwind class at fault, when one class is to blame. */
  class?: string;
  /** What happened, in a sentence. */
  detail: string;
  /** What to do about it. */
  hint: string;
  /** Overrides DEFAULT_FIX when this particular skip is easier or harder than its reason. */
  fix?: Fix;
};

export const fixFor = (skip: Skip): Fix => skip.fix ?? DEFAULT_FIX[skip.reason];

/** Collects skips, dropping repeats - one cause often surfaces from several CSS rules. */
export type Skips = { list: Skip[]; add: (s: Skip) => void };

export const newSkips = (): Skips => {
  const seen = new Set<string>();
  const list: Skip[] = [];
  const add = (s: Skip): void => {
    const key = `${s.reason}|${s.class ?? ""}|${s.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(s);
  };
  return { list, add };
};
