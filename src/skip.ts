export const REASONS = [
  "unknown-class",
  "marker-class",
  "descendant-selector",
  "parent-state",
  "sibling-state",
  "styles-children",
  "dropped-shorthand",
  "unresolved-variable",
  "unsupported-at-rule",
  "dynamic-classes",
  "variant-function",
  "passed-in-classes",
  "lost-condition",
  "two-style-sources",
  "important-modifier",
  "stylex-compile-error",
] as const;

export type Reason = (typeof REASONS)[number];

export const FIXES = ["safe", "check-first", "needs-lookup", "unknown"] as const;

export type Fix = (typeof FIXES)[number];

export const FIX_MEANING: Record<Fix, string> = {
  safe: "one right answer, fine to do in bulk",
  "check-first": "a rewrite exists but can change behaviour; read the code first",
  "needs-lookup": "go find something first - a parent element, a child component",
  unknown: "investigate; often not a Tailwind class at all",
};

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
  "important-modifier": "needs-lookup",
  "stylex-compile-error": "unknown",
};

export type Skip = {
  reason: Reason;
  class?: string;
  detail: string;
  hint: string;
  fix?: Fix;
};

export const fixFor = (skip: Skip): Fix => skip.fix ?? DEFAULT_FIX[skip.reason];

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
