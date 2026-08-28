import postcss, { type AtRule, type Rule } from "postcss";

import type { DesignSystem } from "./resolve.ts";
import { newSkips, type Skip, type Skips } from "./skip.ts";

/** An ordered condition path, outermost first: ['@media (hover: hover)', ':hover'] */
export type ConditionPath = string[];
const KEY = (p: ConditionPath): string => p.join(" ");

export type ResolvedClasses = {
  /** condition key -> { path, property -> value }, filled in application order (later wins). */
  declarations: Map<string, { path: ConditionPath; props: Map<string, string> }>;
  skips: Skip[];
};

/**
 * Shorthands StyleX refuses to compile. `test/stylex-limits.test.ts` compiles every entry and
 * fails if StyleX's real answer ever disagrees, so this list cannot silently go stale - it
 * already had, missing the two block-direction borders.
 */
export const BANNED_SHORTHANDS = new Set([
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
  "border-block-start",
  "border-block-end",
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
  "border-block-start":
    "Write borderBlockStartWidth, borderBlockStartStyle and borderBlockStartColor.",
  "border-block-end": "Write borderBlockEndWidth, borderBlockEndStyle and borderBlockEndColor.",
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

const MARKER = /^(group|peer)(\/[\w-]+)?$/;

const markerHint = (named: string | undefined): string =>
  named === undefined
    ? `Spread stylex.props(stylex.defaultMarker()) on this element; reacting elements use stylex.when.ancestor(':hover').`
    : `Export \`const ${named}Marker = stylex.defineMarker();\` from a .stylex.ts file and spread stylex.props(${named}Marker) here; reacting elements use stylex.when.ancestor(':hover', ${named}Marker).`;

/** Why Tailwind returned no CSS for this className. */
const whyUnresolved = (className: string): Skip => {
  const marker = MARKER.exec(className);
  if (marker) {
    return {
      reason: "marker-class",
      class: className,
      detail: `"${className}" marks this element so descendants or siblings can react to its state.`,
      hint: markerHint(marker[2]?.slice(1)),
    };
  }
  return {
    reason: "unknown-class",
    class: className,
    detail: `Tailwind does not recognise "${className}" in this project's design system.`,
    hint: "Check for a typo, a missing @plugin, or a class defined in plain CSS (which needs no migration).",
  };
};

/** The classNames Tailwind knows, in its own emission order: the last one wins. */
const orderedKnown = (ds: DesignSystem, classNames: string[], skips: Skips): string[] => {
  const ranked: Array<[string, bigint]> = [];
  for (const [className, rank] of ds.getClassOrder(classNames)) {
    if (rank === null) skips.add(whyUnresolved(className));
    else ranked.push([className, rank]);
  }
  return ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([className]) => className);
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
  (declarations: ResolvedClasses["declarations"], twVars: Map<string, string>, skips: Skips) =>
  (path: ConditionPath, decl: postcss.Declaration, className: string): void => {
    const { prop, value: rawValue } = decl;
    if (prop.startsWith("--tw-")) return; // internal plumbing, never emitted

    /**
     * StyleX has no importance: it wins by specificity and argument order instead. postcss
     * parses `!important` into a flag rather than the value, so neither our side nor StyleX's
     * would see it and the gate compared equal - `p-4!` converted to a plain `padding` and
     * quietly stopped beating whatever it was written to beat.
     */
    if (decl.important) {
      skips.add({
        reason: "important-modifier",
        class: className,
        detail: `"${className}" emits "${prop}: ${rawValue} !important", and StyleX has no !important.`,
        hint: "Find the rule this was written to beat. Once that rule is gone, drop the `!` and convert normally; StyleX resolves conflicts by stylex.props() argument order.",
      });
      return;
    }

    if (BANNED_SHORTHANDS.has(prop)) {
      skips.add({
        reason: "dropped-shorthand",
        class: className,
        detail: `"${className}" emits the "${prop}" shorthand, which StyleX drops silently.`,
        hint: LONGHANDS_FOR[prop] ?? `Write the longhands of "${prop}" instead.`,
      });
      return;
    }

    const expanded = expandTwVars(rawValue, twVars).trim();
    if (expanded.includes("var(--tw-")) {
      skips.add({
        reason: "unresolved-variable",
        class: className,
        detail: `"${className}" leaves an unresolved Tailwind slot in "${prop}: ${expanded}".`,
        hint: "Set this property to a literal value, or keep the utility in plain CSS.",
      });
      return;
    }

    const value =
      expanded.includes(",") && COMPOSED_PROPERTY.test(prop) ? tidyList(expanded) : expanded;

    /**
     * Every slot came back empty, so there is no declaration here. v4's bare `transform`,
     * `filter` and `backdrop-filter` do this when no utility fills them: the browser drops the
     * empty declaration, and StyleX's value parser crashes on it outright.
     */
    if (value === "") return;

    const key = KEY(path);
    const group = declarations.get(key) ?? { path, props: new Map<string, string>() };
    declarations.set(key, group);
    group.props.set(camel(prop), value);
  };

type Writer = ReturnType<typeof makeWriter>;
type Walker = (node: postcss.Container, path: ConditionPath, className: string) => void;

/** Walks one className's CSS, turning nested rules and at-rules into condition paths. */
const makeWalker = (write: Writer, skips: Skips): Walker => {
  const walk = (node: postcss.Container, path: ConditionPath, className: string): void => {
    node.each(child => {
      if (child.type === "decl") write(path, child, className);
      else if (child.type === "atrule") walkAtRule(child, path, className);
      else if (child.type === "rule") walkRule(child, path, className);
    });
  };

  const walkAtRule = (at: AtRule, path: ConditionPath, className: string): void => {
    if (at.name === "property") return; // read already, in collectTwVars
    if (!CONDITION_AT_RULES.has(at.name)) {
      skips.add({
        reason: "unsupported-at-rule",
        class: className,
        detail: `"${className}" emits @${at.name}, which has no StyleX condition form.`,
        hint: "Move this rule to a plain CSS file.",
      });
      return;
    }
    walk(at, [...path, `@${at.name} ${at.params}`], className);
  };

  const walkRule = (rule: Rule, path: ConditionPath, className: string): void => {
    const suffix = selfSelector(rule.selector, className);
    if (suffix === null) {
      skips.add(classifySelector(rule.selector, className));
      return;
    }
    walk(rule, suffix ? [...path, suffix] : path, className);
  };

  return walk;
};

/** Resolve one element's full className set into an ordered declaration map. */
export const resolveClasses = (ds: DesignSystem, classNames: string[]): ResolvedClasses => {
  const skips = newSkips();
  const declarations: ResolvedClasses["declarations"] = new Map();

  const known = orderedKnown(ds, classNames, skips);
  const roots = ds.candidatesToCss(known).map(css => (css === null ? null : postcss.parse(css)));

  const walk = makeWalker(makeWriter(declarations, collectTwVars(roots), skips), skips);
  known.forEach((className, i) => {
    const root = roots[i];
    if (root) walk(root, [], className);
  });

  return { declarations, skips: skips.list };
};

const classifySelector = (selector: string, className: string): Skip => {
  const s = esc(selector);
  if (/>\s*:not\(:last-child\)/.test(s) || /^(space|divide)-/.test(className))
    return {
      reason: "styles-children",
      class: className,
      detail: `"${className}" styles this element's children via "${s}".`,
      hint: "Use gap on the parent, or move the style onto the child component.",
    };
  if (/\.group|\.peer/.test(s))
    return {
      reason: "sibling-state",
      class: className,
      detail: `"${className}" depends on a marked ancestor or sibling ("${s}").`,
      hint: "Use stylex.when.ancestor()/siblingBefore() plus stylex.defaultMarker() on that element.",
    };
  // `&:is(.dark *)` and friends: the element matches only under some ancestor.
  if (/^&?:is\(|^&?:where\(/.test(s.trim()) || /\*/.test(s))
    return {
      reason: "parent-state",
      class: className,
      detail: `"${className}" applies only under an ancestor ("${s}").`,
      hint: "For dark mode use stylex.createTheme(); otherwise stylex.when.ancestor() with a marker.",
    };
  return {
    reason: "descendant-selector",
    class: className,
    detail: `"${className}" targets a descendant ("${s}"). StyleX hard-errors on descendant selectors.`,
    hint: "Style the child component directly instead.",
  };
};
