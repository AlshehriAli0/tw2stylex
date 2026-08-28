import postcss, { type AtRule, type Declaration, type Rule } from "postcss";

import { newSkips, type Skip, type Skips } from "./skip.ts";
import type { DesignSystem } from "./tailwind.ts";

type Property = string;
type Value = string;
type ConditionKey = string;

export type ConditionPath = string[];

export type Declarations = {
  path: ConditionPath;
  props: Map<Property, Value>;
};

export type ResolvedClasses = {
  declarations: Map<ConditionKey, Declarations>;
  skips: Skip[];
};

const conditionKey = (path: ConditionPath): ConditionKey => path.join(" ");

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

const LONGHAND_EXCEPTIONS: Record<string, string> = {
  background: "Write backgroundColor (or backgroundImage) instead.",
  animation:
    "Define the keyframes with stylex.keyframes(), then set animationName, animationDuration, animationTimingFunction and animationIterationCount.",
  all: "Set each property this utility touches explicitly.",
};

const camel = (prop: string): string =>
  prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

const longhandsFor = (prop: string): string =>
  LONGHAND_EXCEPTIONS[prop] ??
  `Write ${camel(prop)}Width, ${camel(prop)}Style and ${camel(prop)}Color.`;

const unescape = (s: string): string => s.replace(/\\(.)/g, "$1");

const EMPTY_SLOT_VALUES = new Set(["0 0 #0000", "none", ""]);
const CONDITION_AT_RULES = new Set(["media", "supports", "container"]);
const COMPOSES_A_LIST = /shadow|filter|transition|transform/;
const MARKER_CLASS = /^(group|peer)(\/[\w-]+)?$/;
const OPENERS = "([";
const CLOSERS = ")]";

const splitOnTopLevelCommas = (input: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? "";
    if (char === "\\") {
      current += char + (input[++i] ?? "");
      continue;
    }
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;

    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  parts.push(current);
  return parts;
};

const withoutAttributeValues = (selector: string): string =>
  selector.replace(/"[^"]*"|'[^']*'/g, '""');

const reachesAnotherElement = (suffix: string): boolean =>
  /[\s>+~]/.test(withoutAttributeValues(suffix));

const afterClass = (part: string, dottedClass: string): string | null => {
  const selector = unescape(part);
  if (selector.startsWith("&")) return selector.slice(1);
  if (selector.startsWith(dottedClass)) return selector.slice(dottedClass.length);
  return null;
};

export const selfSelector = (selector: string, className: string): string | null => {
  const dottedClass = `.${className}`;
  const suffixes = new Set<string>();

  for (const part of splitOnTopLevelCommas(selector)) {
    const suffix = afterClass(part.trim(), dottedClass);
    if (suffix === null || reachesAnotherElement(suffix)) return null;
    suffixes.add(suffix);
  }

  const single = suffixes.size === 1;
  return single ? ([...suffixes][0] ?? null) : null;
};

const closingParen = (value: string, open: number): number => {
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

const slotValueOrFallback = (inner: string, slots: Map<string, string>): string => {
  const [name = "", ...fallback] = splitOnTopLevelCommas(inner);
  return slots.get(name.trim()) ?? fallback.join(",").trim();
};

const MAX_SLOT_DEPTH = 10;

const fillTwSlots = (value: string, slots: Map<string, string>, depth = 0): string => {
  if (depth > MAX_SLOT_DEPTH || !value.includes("var(--tw-")) return value;

  const at = value.indexOf("var(--tw-");
  if (at === -1) return value;

  const close = closingParen(value, at + 3);
  const inner = value.slice(at + 4, close);
  const filled = fillTwSlots(slotValueOrFallback(inner, slots), slots, depth + 1);

  return value.slice(0, at) + filled + fillTwSlots(value.slice(close + 1), slots, depth);
};

const withoutEmptySlots = (value: string): string => {
  const parts = splitOnTopLevelCommas(value)
    .map(part => part.trim())
    .filter(part => !EMPTY_SLOT_VALUES.has(part));
  return parts.length > 0 ? parts.join(", ") : "none";
};

const markerHint = (name: string | undefined): string =>
  name === undefined
    ? `Spread stylex.props(stylex.defaultMarker()) on this element; reacting elements use stylex.when.ancestor(':hover').`
    : `Export \`const ${name}Marker = stylex.defineMarker();\` from a .stylex.ts file and spread stylex.props(${name}Marker) here; reacting elements use stylex.when.ancestor(':hover', ${name}Marker).`;

const skipForNoCss = (className: string): Skip => {
  const marker = MARKER_CLASS.exec(className);
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

const inTailwindOrder = (ds: DesignSystem, classNames: string[], skips: Skips): string[] => {
  const ranked: Array<[string, bigint]> = [];
  for (const [className, rank] of ds.getClassOrder(classNames)) {
    if (rank === null) skips.add(skipForNoCss(className));
    else ranked.push([className, rank]);
  }
  return ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([className]) => className);
};

type Roots = Array<postcss.Root | null>;

const slotDefaults = (roots: Roots): Map<string, string> => {
  const defaults = new Map<string, string>();
  for (const root of roots)
    root?.walkAtRules("property", at => {
      at.walkDecls("initial-value", decl => {
        defaults.set(at.params.trim(), decl.value);
      });
    });
  return defaults;
};

const slotsFromClasses = (roots: Roots): Map<string, string> => {
  const set = new Map<string, string>();
  for (const root of roots)
    root?.walkDecls(decl => {
      if (decl.prop.startsWith("--tw-")) set.set(decl.prop, decl.value);
    });
  return set;
};

const twSlots = (roots: Roots): Map<string, string> =>
  new Map([...slotDefaults(roots), ...slotsFromClasses(roots)]);

const skipForSelector = (selector: string, className: string): Skip => {
  const readable = unescape(selector);
  if (/>\s*:not\(:last-child\)/.test(readable) || /^(space|divide)-/.test(className))
    return {
      reason: "styles-children",
      class: className,
      detail: `"${className}" styles this element's children via "${readable}".`,
      hint: "Use gap on the parent, or move the style onto the child component.",
    };
  if (/\.group|\.peer/.test(readable))
    return {
      reason: "sibling-state",
      class: className,
      detail: `"${className}" depends on a marked ancestor or sibling ("${readable}").`,
      hint: "Use stylex.when.ancestor()/siblingBefore() plus stylex.defaultMarker() on that element.",
    };
  if (/^&?:is\(|^&?:where\(/.test(readable.trim()) || /\*/.test(readable))
    return {
      reason: "parent-state",
      class: className,
      detail: `"${className}" applies only under an ancestor ("${readable}").`,
      hint: "For dark mode use stylex.createTheme(); otherwise stylex.when.ancestor() with a marker.",
    };
  return {
    reason: "descendant-selector",
    class: className,
    detail: `"${className}" targets a descendant ("${readable}"). StyleX hard-errors on descendant selectors.`,
    hint: "Style the child component directly instead.",
  };
};

export const resolveClasses = (ds: DesignSystem, classNames: string[]): ResolvedClasses => {
  const skips = newSkips();
  const declarations: ResolvedClasses["declarations"] = new Map();
  const known = inTailwindOrder(ds, classNames, skips);
  const roots = ds.candidatesToCss(known).map(css => (css === null ? null : postcss.parse(css)));
  const slots = twSlots(roots);

  const record = (path: ConditionPath, property: string, value: string): void => {
    const key = conditionKey(path);
    const group = declarations.get(key) ?? { path, props: new Map<string, string>() };
    declarations.set(key, group);
    group.props.set(property, value);
  };

  const addDeclaration = (path: ConditionPath, decl: Declaration, className: string): void => {
    const isInternalSlot = decl.prop.startsWith("--tw-");
    if (isInternalSlot) return;

    if (decl.important) {
      skips.add({
        reason: "important-modifier",
        class: className,
        detail: `"${className}" emits "${decl.prop}: ${decl.value} !important", and StyleX has no !important.`,
        hint: "Find the rule this was written to beat. Once that rule is gone, drop the `!` and convert normally; StyleX resolves conflicts by stylex.props() argument order.",
      });
      return;
    }

    if (BANNED_SHORTHANDS.has(decl.prop)) {
      skips.add({
        reason: "dropped-shorthand",
        class: className,
        detail: `"${className}" emits the "${decl.prop}" shorthand, which StyleX drops silently.`,
        hint: longhandsFor(decl.prop),
      });
      return;
    }

    const filled = fillTwSlots(decl.value, slots).trim();
    if (filled.includes("var(--tw-")) {
      skips.add({
        reason: "unresolved-variable",
        class: className,
        detail: `"${className}" leaves an unresolved Tailwind slot in "${decl.prop}: ${filled}".`,
        hint: "Set this property to a literal value, or keep the utility in plain CSS.",
      });
      return;
    }

    const composed = filled.includes(",") && COMPOSES_A_LIST.test(decl.prop);
    const value = composed ? withoutEmptySlots(filled) : filled;

    const nothingToWrite = value === "";
    if (nothingToWrite) return;

    record(path, camel(decl.prop), value);
  };

  const walk = (node: postcss.Container, path: ConditionPath, className: string): void => {
    node.each(child => {
      if (child.type === "decl") addDeclaration(path, child, className);
      else if (child.type === "atrule") walkAtRule(child, path, className);
      else if (child.type === "rule") walkRule(child, path, className);
    });
  };

  const walkAtRule = (at: AtRule, path: ConditionPath, className: string): void => {
    const readElsewhere = at.name === "property";
    if (readElsewhere) return;

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
      skips.add(skipForSelector(rule.selector, className));
      return;
    }
    walk(rule, suffix ? [...path, suffix] : path, className);
  };

  known.forEach((className, i) => {
    const root = roots[i];
    if (root) walk(root, [], className);
  });

  return { declarations, skips: skips.list };
};
