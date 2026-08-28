import postcss, { type AtRule, type Rule } from "postcss";

import type { DesignSystem } from "./resolve.ts";

/** Why a Site or Candidate could not be converted. Closed enum: the skill has one section per code. */
export const REASONS = [
  "unknown-candidate", // Tailwind itself does not recognise the class
  "marker-class", // `group`/`peer`/`group//name` - becomes a StyleX Marker
  "descendant-selector", // [&_svg]:, [&>*]: - StyleX hard-errors on these
  "ancestor-state", // dark:, in-* - depends on an ancestor matching
  "sibling-variant", // group-*/peer-* - needs a Marker on another element
  "child-styling-utility", // space-x-*, divide-* - style children, not self
  "banned-shorthand", // background/border/animation - StyleX drops these silently
  "unresolved-tw-var", // a --tw-* slot with no value and no @property initial-value
  "unsupported-at-rule", // @starting-style and friends
  "dynamic-expression", // className built at runtime
  "cva-call",
  "contract-change",
  "condition-erasure",
  "conflicting-props", // element also carries a style/className attr alongside the spread
] as const;
export type Reason = (typeof REASONS)[number];

/**
 * What the agent should DO about a refusal - orthogonal to why it happened.
 * Mirrors rustc's suggestion_applicability.
 */
export type Applicability =
  | "machine-applicable"
  | "maybe-incorrect"
  | "has-placeholders"
  | "unspecified";

/** Default action-class per reason. A Refusal may override it. */
export const APPLICABILITY: Record<Reason, Applicability> = {
  "unknown-candidate": "unspecified",
  "marker-class": "machine-applicable",
  "descendant-selector": "has-placeholders",
  "ancestor-state": "has-placeholders",
  "sibling-variant": "has-placeholders",
  "child-styling-utility": "maybe-incorrect",
  "banned-shorthand": "machine-applicable",
  "unresolved-tw-var": "maybe-incorrect",
  "unsupported-at-rule": "has-placeholders",
  "dynamic-expression": "maybe-incorrect",
  "cva-call": "machine-applicable",
  "contract-change": "maybe-incorrect",
  "condition-erasure": "maybe-incorrect",
  "conflicting-props": "maybe-incorrect",
};

export type Refusal = {
  reason: Reason;
  candidate?: string;
  detail: string;
  hint: string;
  applicability?: Applicability;
};

/** An ordered condition path, outermost first: ['@media (hover: hover)', ':hover'] */
export type CondPath = string[];
const KEY = (p: CondPath): string => p.join(" ");

export type Resolved = {
  /** condition key -> { path, property -> value }, filled in application order (later wins). */
  decls: Map<string, { path: CondPath; props: Map<string, string> }>;
  refusals: Refusal[];
};

const BANNED_SHORTHANDS = new Set([
  "all",
  "animation",
  "background",
  "border",
  "border-inline",
  "border-block",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-inline-start",
  "border-inline-end",
]);

/** The longhand set to write in place of each banned shorthand. */
const LONGHANDS_FOR: Record<string, string> = {
  background: "Write backgroundColor (or backgroundImage) instead.",
  animation:
    "Define the keyframes with stylex.keyframes(), then set animationName, animationDuration, animationTimingFunction and animationIterationCount.",
  border: "Write borderWidth, borderStyle and borderColor.",
  "border-top": "Write borderTopWidth, borderTopStyle and borderTopColor.",
  "border-right": "Write borderRightWidth, borderRightStyle and borderRightColor.",
  "border-bottom": "Write borderBottomWidth, borderBottomStyle and borderBottomColor.",
  "border-left": "Write borderLeftWidth, borderLeftStyle and borderLeftColor.",
  "border-inline": "Write borderInlineWidth, borderInlineStyle and borderInlineColor.",
  "border-block": "Write borderBlockWidth, borderBlockStyle and borderBlockColor.",
  "border-inline-start":
    "Write borderInlineStartWidth, borderInlineStartStyle and borderInlineStartColor.",
  "border-inline-end": "Write borderInlineEndWidth, borderInlineEndStyle and borderInlineEndColor.",
  all: "Set each property this utility touches explicitly.",
};

/** Values Tailwind uses as "this slot is empty"; dropping them keeps output readable. */
const NOOP_VALUES = new Set(["0 0 #0000", "none", ""]);

const camel = (p: string): string =>
  p.startsWith("--") ? p : p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const esc = (s: string): string => s.replace(/\\(.)/g, "$1");

/** At-rules StyleX can express as a condition key. */
const CONDITION_AT_RULES = new Set(["media", "supports", "container"]);

const OPENERS = "([";
const CLOSERS = ")]";

/**
 * Split on top-level commas. A comma inside brackets or escaped with a backslash belongs to
 * the value, not the list - `cubic-bezier(0.22,1)` and `.ease-\[a\,b\]` must stay whole.
 */
const splitTopLevel = (input: string): string[] => {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (ch === "\\") {
      cur += ch + (input[++i] ?? "");
      continue;
    }
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;

    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  parts.push(cur);
  return parts;
};

/**
 * Does this selector target only the element carrying the class?
 * Handles both flat (`.foo:hover`) and v4's nested (`&:hover`) forms.
 * Returns the suffix, or null if the selector reaches another element.
 */
/** Strip the leading `&` or `.class`, leaving the suffix - or null if it targets something else. */
const selfSuffix = (part: string, cls: string): string | null => {
  const unescaped = esc(part);
  if (unescaped.startsWith("&")) return unescaped.slice(1);
  if (unescaped.startsWith(cls)) return unescaped.slice(cls.length);
  return null;
};

/**
 * A combinator anywhere - including nested inside `:is()`/`:where()` - means the selector
 * describes a relationship to another element, which StyleX cannot express as a
 * self-condition. Attribute values are masked first so `[x="a b"]` still counts as self.
 */
const isRelational = (suffix: string): boolean =>
  /[\s>+~]/.test(suffix.replace(/"[^"]*"|'[^']*'/g, '""'));

/**
 * Does this selector target only the element carrying the class?
 * Handles both flat (`.foo:hover`) and v4's nested (`&:hover`) forms.
 * Returns the suffix, or null if the selector reaches another element.
 */
export const selfSelector = (selector: string, className: string): string | null => {
  const cls = `.${className}`;
  const suffixes = new Set<string>();

  for (const part of splitTopLevel(selector)) {
    const suffix = selfSuffix(part.trim(), cls);
    if (suffix === null || isRelational(suffix)) return null;
    suffixes.add(suffix);
  }

  // A list whose branches want different suffixes has no single self-condition.
  return suffixes.size === 1 ? ([...suffixes][0] ?? null) : null;
};

/** Index of the `)` closing the `(` at `open`. */
const matchingParen = (value: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === "(") depth += 1;
    else if (value[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return value.length;
};

/** `var(--tw-x, fallback)` -> the element's value for --tw-x, else the fallback. */
const substitute = (inner: string, vars: Map<string, string>): string => {
  const [name = "", ...rest] = splitTopLevel(inner);
  return vars.get(name.trim()) ?? rest.join(",").trim();
};

const MAX_VAR_DEPTH = 10;

/** Substitute `var(--tw-x, fallback)` using values the element's own classes set. */
const expandTwVars = (value: string, vars: Map<string, string>, depth = 0): string => {
  if (depth > MAX_VAR_DEPTH || !value.includes("var(--tw-")) return value;

  const at = value.indexOf("var(--tw-");
  if (at === -1) return value;

  const close = matchingParen(value, at + 3);
  const inner = value.slice(at + 4, close);
  const resolved = expandTwVars(substitute(inner, vars), vars, depth + 1);

  return value.slice(0, at) + resolved + expandTwVars(value.slice(close + 1), vars, depth);
};

/** Drop Tailwind's empty-slot placeholders from a composed list value. */
const tidyList = (value: string): string => {
  const parts = splitTopLevel(value)
    .map(p => p.trim())
    .filter(p => p !== "" && !NOOP_VALUES.has(p));
  return parts.length > 0 ? parts.join(", ") : "none";
};

/** Collects refusals, dropping repeats - one cause often surfaces from several rules. */
type Refusals = { list: Refusal[]; add: (r: Refusal) => void };

const makeRefusals = (): Refusals => {
  const seen = new Set<string>();
  const list: Refusal[] = [];
  const add = (r: Refusal): void => {
    const k = `${r.reason}|${r.candidate}|${r.detail}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push(r);
  };
  return { list, add };
};

const MARKER = /^(group|peer)(\/[\w-]+)?$/;

const markerHint = (named: string | undefined): string =>
  named === undefined
    ? `Spread stylex.props(stylex.defaultMarker()) on this element; reacting elements use stylex.when.ancestor(':hover').`
    : `Export \`const ${named}Marker = stylex.defineMarker();\` from a .stylex.ts file and spread stylex.props(${named}Marker) here; reacting elements use stylex.when.ancestor(':hover', ${named}Marker).`;

/** Why Tailwind returned no CSS for this candidate. */
const unresolvedCandidate = (candidate: string): Refusal => {
  const marker = MARKER.exec(candidate);
  if (marker) {
    return {
      reason: "marker-class",
      candidate,
      detail: `"${candidate}" marks this element so descendants or siblings can react to its state.`,
      hint: markerHint(marker[2]?.slice(1)),
    };
  }
  return {
    reason: "unknown-candidate",
    candidate,
    detail: `Tailwind does not recognise "${candidate}" in this project's design system.`,
    hint: "Check for a typo, a missing @plugin, or a class defined in plain CSS (which needs no migration).",
  };
};

/** The candidates Tailwind knows, in its own emission order: the last one wins. */
const orderedKnown = (ds: DesignSystem, candidates: string[], refusals: Refusals): string[] => {
  const ranked: Array<[string, bigint]> = [];
  for (const [candidate, rank] of ds.getClassOrder(candidates)) {
    if (rank === null) refusals.add(unresolvedCandidate(candidate));
    else ranked.push([candidate, rank]);
  }
  return ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([candidate]) => candidate);
};

/**
 * Tailwind composes box-shadow, filter and friends from several classes through `--tw-*`
 * slots. `@property` initial-values are the defaults; the element's own classes override
 * them. A slot with no initial-value stays unset so its `var(x, fallback)` keeps the fallback.
 */
const collectTwVars = (roots: Array<postcss.Root | null>): Map<string, string> => {
  const vars = new Map<string, string>();
  for (const root of roots) {
    root?.walkAtRules("property", at => {
      at.walkDecls("initial-value", d => {
        vars.set(at.params.trim(), d.value);
      });
    });
  }
  for (const root of roots) {
    root?.walkDecls(d => {
      if (d.prop.startsWith("--tw-")) vars.set(d.prop, d.value);
    });
  }
  return vars;
};

const COMPOSED_PROPERTY = /shadow|filter|transition|transform/;

/** Writes one resolved declaration, or refuses it. */
const makeWriter =
  (decls: Resolved["decls"], twVars: Map<string, string>, refusals: Refusals) =>
  (path: CondPath, prop: string, rawValue: string, candidate: string): void => {
    if (prop.startsWith("--tw-")) return; // internal plumbing, never emitted

    if (BANNED_SHORTHANDS.has(prop)) {
      refusals.add({
        reason: "banned-shorthand",
        candidate,
        detail: `"${candidate}" emits the "${prop}" shorthand, which StyleX drops silently.`,
        hint: LONGHANDS_FOR[prop] ?? `Write the longhands of "${prop}" instead.`,
      });
      return;
    }

    const expanded = expandTwVars(rawValue, twVars).trim();
    if (expanded.includes("var(--tw-")) {
      refusals.add({
        reason: "unresolved-tw-var",
        candidate,
        detail: `"${candidate}" leaves an unresolved Tailwind slot in "${prop}: ${expanded}".`,
        hint: "Set this property to a literal value, or keep the utility in plain CSS.",
      });
      return;
    }

    const value =
      expanded.includes(",") && COMPOSED_PROPERTY.test(prop) ? tidyList(expanded) : expanded;
    const key = KEY(path);
    const group = decls.get(key) ?? { path, props: new Map<string, string>() };
    decls.set(key, group);
    group.props.set(camel(prop), value);
  };

type Writer = ReturnType<typeof makeWriter>;
type Walker = (node: postcss.Container, path: CondPath, candidate: string) => void;

/** Walks one candidate's CSS, turning nested rules and at-rules into condition paths. */
const makeWalker = (write: Writer, refusals: Refusals): Walker => {
  const walk = (node: postcss.Container, path: CondPath, candidate: string): void => {
    node.each(child => {
      if (child.type === "decl") write(path, child.prop, child.value, candidate);
      else if (child.type === "atrule") walkAtRule(child, path, candidate);
      else if (child.type === "rule") walkRule(child, path, candidate);
    });
  };

  const walkAtRule = (at: AtRule, path: CondPath, candidate: string): void => {
    if (at.name === "property") return; // read already, in collectTwVars
    if (!CONDITION_AT_RULES.has(at.name)) {
      refusals.add({
        reason: "unsupported-at-rule",
        candidate,
        detail: `"${candidate}" emits @${at.name}, which has no StyleX condition form.`,
        hint: "Move this rule to a plain CSS file.",
      });
      return;
    }
    walk(at, [...path, `@${at.name} ${at.params}`], candidate);
  };

  const walkRule = (rule: Rule, path: CondPath, candidate: string): void => {
    const suffix = selfSelector(rule.selector, candidate);
    if (suffix === null) {
      refusals.add(classifySelector(rule.selector, candidate));
      return;
    }
    walk(rule, suffix ? [...path, suffix] : path, candidate);
  };

  return walk;
};

/** Resolve one element's full candidate set into an ordered declaration map. */
export const resolveElement = (ds: DesignSystem, candidates: string[]): Resolved => {
  const refusals = makeRefusals();
  const decls: Resolved["decls"] = new Map();

  const known = orderedKnown(ds, candidates, refusals);
  const roots = ds.candidatesToCss(known).map(css => (css === null ? null : postcss.parse(css)));

  const walk = makeWalker(makeWriter(decls, collectTwVars(roots), refusals), refusals);
  known.forEach((candidate, i) => {
    const root = roots[i];
    if (root) walk(root, [], candidate);
  });

  return { decls, refusals: refusals.list };
};

const classifySelector = (selector: string, candidate: string): Refusal => {
  const s = esc(selector);
  if (/>\s*:not\(:last-child\)/.test(s) || /^(space|divide)-/.test(candidate))
    return {
      reason: "child-styling-utility",
      candidate,
      detail: `"${candidate}" styles this element's children via "${s}".`,
      hint: "Use gap on the parent, or move the style onto the child component.",
    };
  if (/\.group|\.peer/.test(s))
    return {
      reason: "sibling-variant",
      candidate,
      detail: `"${candidate}" depends on a marked ancestor or sibling ("${s}").`,
      hint: "Use stylex.when.ancestor()/siblingBefore() plus stylex.defaultMarker() on that element.",
    };
  // `&:is(.dark *)` and friends: the element matches only under some ancestor.
  if (/^&?:is\(|^&?:where\(/.test(s.trim()) || /\*/.test(s))
    return {
      reason: "ancestor-state",
      candidate,
      detail: `"${candidate}" applies only under an ancestor ("${s}").`,
      hint: "For dark mode use stylex.createTheme(); otherwise stylex.when.ancestor() with a marker.",
    };
  return {
    reason: "descendant-selector",
    candidate,
    detail: `"${candidate}" targets a descendant ("${s}"). StyleX hard-errors on descendant selectors.`,
    hint: "Style the child component directly instead.",
  };
};
