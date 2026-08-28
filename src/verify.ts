import { transformSync } from "@babel/core";
import stylexPluginMod from "@stylexjs/babel-plugin";
import postcss from "postcss";

import { printCreate, type SxNamespace } from "./emit.ts";
import { cjsDefault } from "./interop.ts";
import type { Resolved } from "./reshape.ts";

const stylexPlugin: unknown =
  typeof stylexPluginMod === "function" ? stylexPluginMod : cjsDefault(stylexPluginMod);

export type CompiledRule = { className: string; css: string; priority: number };

export type Mismatch = {
  namespace: string;
  condition: string;
  property: string;
  tailwind: string | undefined;
  stylex: string | undefined;
};

export type VerifyResult =
  | { ok: true; rules: CompiledRule[] }
  | { ok: false; kind: "compile-error"; message: string }
  | { ok: false; kind: "mismatch"; mismatches: Mismatch[]; rules: CompiledRule[] };

/** A group of declarations sharing one condition path. */
export type DeclGroup = { path: string[]; props: Map<string, string> };

/** condition key -> property -> value */
type DeclIndex = Map<string, Map<string, string>>;

// StyleX hashes class names from the filename, and Babel caches per filename. Reusing one
// virtual name across compiles made results depend on how many files had been processed
// before - a determinism bug that showed up as different totals under Node vs Bun.
let compileSeq = 0;

type StyleXRule = [className: string, css: { ltr: string }, priority: number];
type StyleXMeta = StyleXRule[];

const readMeta = (metadata: unknown): StyleXMeta => {
  if (typeof metadata !== "object" || metadata === null) return [];
  const { stylex } = metadata as { stylex?: unknown };
  return Array.isArray(stylex) ? (stylex as StyleXMeta) : [];
};

/** Compile a stylex.create source through the real StyleX Babel plugin. */
export const compileStyleX = (source: string): { rules: CompiledRule[] } | { error: string } => {
  const code = `import * as stylex from '@stylexjs/stylex';\n${source}\nexport { styles };\n`;
  try {
    const res = transformSync(code, {
      filename: `/tw2sx/virtual-${compileSeq++}.js`,
      babelrc: false,
      configFile: false,
      plugins: [
        [
          stylexPlugin,
          {
            dev: false,
            runtimeInjection: false,
            enableMinifiedKeys: false,
            // StyleX rewrites overlapping min-width queries into non-overlapping ranges
            // (`(min-width:40rem) and (max-width:63.99rem)`). That is semantics-preserving -
            // Tailwind reaches the same result through source order - but it obscures a
            // declaration-level diff, so compare against the authored queries.
            enableMediaQueryOrder: false,
            // Surface the silently-dropped shorthands instead of losing them.
            propertyValidationMode: "throw",
            unstable_moduleResolution: { type: "commonJS", rootDir: "/tw2sx" },
          },
        ],
      ],
    });
    const rules = readMeta(res?.metadata).map(([className, rule, priority]) => ({
      className,
      css: rule.ltr,
      priority,
    }));
    return { rules };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

/** StyleX selectors look like `.xabc.xabc:hover`; strip the class prefix down to the suffix. */
const suffixOf = (selector: string): string =>
  selector.replace(/^(\.[A-Za-z0-9_-]+)+/, "").replace(/:not\(#\\?#\)/g, "");

/** Parse StyleX's emitted atomic rules back into condition-path groups. */
export const declsFromRules = (rules: CompiledRule[]): DeclGroup[] => {
  const groups: DeclGroup[] = [];
  const byKey = new Map<string, DeclGroup>();

  const walk = (node: postcss.Container, path: string[]): void => {
    node.each(child => {
      if (child.type === "decl") {
        const key = path.join(" ");
        let group = byKey.get(key);
        if (!group) {
          group = { path, props: new Map<string, string>() };
          byKey.set(key, group);
          groups.push(group);
        }
        group.props.set(child.prop, child.value.trim());
      } else if (child.type === "atrule") {
        walk(child, [...path, `@${child.name} ${child.params}`]);
      } else if (child.type === "rule") {
        const suffix = suffixOf(child.selector);
        walk(child, suffix ? [...path, suffix] : path);
      }
    });
  };

  for (const { css } of rules) walk(postcss.parse(css), []);
  return groups;
};

/**
 * Canonicalise one condition. The two systems spell the same thing differently:
 * Tailwind v4 emits CSS range syntax, StyleX emits min-/max-width.
 */
const normaliseSegment = (segment: string): string => {
  const t = segment.trim().replace(/\s+/g, " ").replace(/'/g, '"');
  const media = /^@media \((.+)\)$/.exec(t);
  const query = media?.[1];
  if (query === undefined) return t;
  const canonical = query
    .replace(/^width\s*>=?\s*(.+)$/, "min-width: $1")
    .replace(/^width\s*<=?\s*(.+)$/, "max-width: $1")
    .replace(/\s*:\s*/, ": ");
  return `@media (${canonical})`;
};

/** Split a selector suffix into its atoms: `:active:not(*[x])` -> [':active', ':not(*[x])']. */
const selectorAtoms = (s: string): string[] => {
  const atoms = s.match(/(?:::?[A-Za-z-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\])/g);
  if (atoms) return atoms;
  return s.trim() ? [s.trim()] : [];
};

/**
 * Normalise a condition path for comparison across the two systems.
 * Tailwind nests `&:active { &:not(x) }` where StyleX flattens to `:active:not(x)`,
 * so selector atoms are pooled and sorted independently of at-rules.
 */
export const normCondition = (path: string[]): string => {
  const atRules: string[] = [];
  const atoms: string[] = [];
  for (const segment of path.map(normaliseSegment).filter(Boolean)) {
    // v4 wraps every hover in a hover-capability query; StyleX does not.
    if (segment === "@media (hover: hover)") continue;
    if (segment.startsWith("@")) atRules.push(segment);
    else atoms.push(...selectorAtoms(segment));
  }
  return [...atRules.sort(), atoms.sort().join("")].filter(Boolean).join(" ");
};

const trimNum = (n: number): string => String(n).replace(/^0\./, ".");

/**
 * StyleX runs values through lightningcss, which minifies them. Undo the
 * minifications so a value difference means a real difference.
 */
const normValue = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    // leading zero dropped: 0.1 -> .1
    .replace(/(^|[\s,(/])0\.(\d)/g, "$1.$2")
    // ms collapsed to s: 150ms -> .15s
    .replace(
      /(^|[\s,(])(\d*\.?\d+)ms\b/g,
      (_m, prefix: string, n: string) => `${prefix}${trimNum(Number(n) / 1000)}s`,
    )
    // any zero length is just 0
    .replace(/(^|[\s,(])0(?:px|rem|em|%|vh|vw|s)\b/g, "$10")
    // slash spacing differs: `4/3` vs `4 / 3`, `rgb(x)/0.3` vs `rgb(x) / .3`
    .replace(/\s*\/\s*/g, "/")
    .replace(/;$/, "");

const kebab = (p: string): string =>
  p.startsWith("--") ? p : p.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

const identity = (p: string): string => p;

/** Collapse declaration groups into condition -> property -> value, normalising both keys. */
const indexOf = (groups: DeclGroup[], keyOf: (prop: string) => string): DeclIndex => {
  const index: DeclIndex = new Map();
  for (const { path, props } of groups) {
    const cond = normCondition(path);
    const bucket = index.get(cond) ?? new Map<string, string>();
    index.set(cond, bucket);
    for (const [prop, value] of props) bucket.set(keyOf(prop), value);
  }
  return index;
};

/** Flatten an index to one entry per (condition, property). */
const entriesOf = (index: DeclIndex): Array<[cond: string, property: string, value: string]> =>
  [...index].flatMap(([cond, props]) =>
    [...props].map(([property, value]): [string, string, string] => [cond, property, value]),
  );

/** Declarations Tailwind produced that StyleX did not reproduce, value included. */
const missingOrWrong = (namespace: string, expected: DeclIndex, actual: DeclIndex): Mismatch[] =>
  entriesOf(expected)
    .map(([cond, property, want]) => ({
      cond,
      property,
      want,
      got: actual.get(cond)?.get(property),
    }))
    .filter(({ want, got }) => got === undefined || normValue(got) !== normValue(want))
    .map(({ cond, property, want, got }) => ({
      namespace,
      condition: cond || "default",
      property,
      tailwind: want,
      stylex: got,
    }));

/** Declarations StyleX emitted that Tailwind never asked for. */
const unexpected = (namespace: string, expected: DeclIndex, actual: DeclIndex): Mismatch[] =>
  entriesOf(actual)
    .filter(([cond, property]) => expected.get(cond)?.has(property) !== true)
    .map(([cond, property, got]) => ({
      namespace,
      condition: cond || "default",
      property,
      tailwind: undefined,
      stylex: got,
    }));

/** Every (condition, property) where the two sides disagree, checked in both directions. */
const diffIndexes = (namespace: string, expected: DeclIndex, actual: DeclIndex): Mismatch[] => [
  ...missingOrWrong(namespace, expected, actual),
  ...unexpected(namespace, expected, actual),
];

/**
 * ADR-0003: the correctness gate. Compare the declarations Tailwind produced against
 * the declarations the generated StyleX actually compiles to.
 */
export const verifyNamespace = (
  name: string,
  resolved: Resolved,
  ns: SxNamespace,
): VerifyResult => {
  const compiled = compileStyleX(printCreate({ [name]: ns }));
  if ("error" in compiled) return { ok: false, kind: "compile-error", message: compiled.error };

  const expected = indexOf([...resolved.decls.values()], kebab);
  const actual = indexOf(declsFromRules(compiled.rules), identity);
  const mismatches = diffIndexes(name, expected, actual);

  if (mismatches.length > 0)
    return { ok: false, kind: "mismatch", mismatches, rules: compiled.rules };
  return { ok: true, rules: compiled.rules };
};
