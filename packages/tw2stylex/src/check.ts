import { createRequire } from "node:module";

import postcss from "postcss";

import { cjsDefault, isRecord } from "./cjs.ts";
import type { ResolvedClasses } from "./classes-to-css.ts";
import { printCreate, type Style } from "./css-to-stylex.ts";

const require_ = createRequire(import.meta.url);

const once = <T>(load: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= load());
};

type Transform = typeof import("@babel/core").transformSync;
type TransformOptions = Parameters<Transform>[1];

const isTransform = (v: unknown): v is Transform => typeof v === "function";

const babelTransform = once((): Transform => {
  const core: unknown = require_("@babel/core");
  if (!isRecord(core) || !isTransform(core.transformSync))
    throw new Error("@babel/core did not provide transformSync.");
  return core.transformSync;
});

const stylexPlugin = once((): unknown => {
  const plugin: unknown = require_("@stylexjs/babel-plugin");
  return typeof plugin === "function" ? plugin : cjsDefault(plugin);
});

export type CompiledRule = { className: string; css: string; priority: number };

export type Mismatch = {
  styleName: string;
  condition: string;
  property: string;
  tailwind: string | undefined;
  stylex: string | undefined;
};

export type VerifyResult =
  | { ok: true; rules: CompiledRule[] }
  | { ok: false; kind: "compile-error"; message: string }
  | { ok: false; kind: "mismatch"; mismatches: Mismatch[]; rules: CompiledRule[] };

type Condition = string;
type Property = string;
type Value = string;

export type DeclarationGroup = { path: Condition[]; props: Map<Property, Value> };

type DeclIndex = Map<Condition, Map<Property, Value>>;

type StyleXRule = [className: string, css: { ltr: string }, priority: number];
type StyleXMeta = StyleXRule[];

const readMeta = (metadata: unknown): StyleXMeta => {
  if (typeof metadata !== "object" || metadata === null) return [];
  const { stylex } = metadata as { stylex?: unknown };
  return Array.isArray(stylex) ? (stylex as StyleXMeta) : [];
};

const KEEP_MEDIA_QUERIES_AS_IS = false;
const REPORT_DROPPED_SHORTHANDS = "throw";

const babelOptions = once((): TransformOptions => ({
  filename: "/tw2sx/virtual.js",
  babelrc: false,
  configFile: false,
  plugins: [
    [
      stylexPlugin(),
      {
        dev: false,
        runtimeInjection: false,
        enableMinifiedKeys: false,
        enableMediaQueryOrder: KEEP_MEDIA_QUERIES_AS_IS,
        propertyValidationMode: REPORT_DROPPED_SHORTHANDS,
        unstable_moduleResolution: { type: "commonJS", rootDir: "/tw2sx" },
      },
    ],
  ],
}));

export const compileStyleX = (
  source: string,
): { rules: CompiledRule[]; code: string } | { error: string } => {
  const code = `import * as stylex from '@stylexjs/stylex';\n${source}\nexport { styles };\n`;
  try {
    const res = babelTransform()(code, babelOptions());
    if (res?.code === null || res?.code === undefined)
      throw new Error("StyleX compiler emitted no code.");
    const rules = readMeta(res?.metadata).map(([className, rule, priority]) => ({
      className,
      css: rule.ltr,
      priority,
    }));
    return { rules, code: res.code };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const conditionPart = (selector: string): string =>
  selector.replace(/^(\.[A-Za-z0-9_-]+)+/, "").replace(/:not\(#\\?#\)/g, "");

type FlatDecl = { path: string[]; property: string; value: string };

const declarationsByClassName = new Map<string, FlatDecl[]>();

const declarationsIn = (css: string): FlatDecl[] => {
  const flat: FlatDecl[] = [];

  const walk = (node: postcss.Container, path: string[]): void => {
    node.each(child => {
      if (child.type === "decl")
        flat.push({ path, property: child.prop, value: child.value.trim() });
      else if (child.type === "atrule") walk(child, [...path, `@${child.name} ${child.params}`]);
      else if (child.type === "rule") {
        const suffix = conditionPart(child.selector);
        walk(child, suffix ? [...path, suffix] : path);
      }
    });
  };

  walk(postcss.parse(css), []);
  return flat;
};

export const declsFromRules = (rules: CompiledRule[]): DeclarationGroup[] => {
  const groups: DeclarationGroup[] = [];
  const byCondition = new Map<string, DeclarationGroup>();

  for (const { className, css } of rules) {
    let flat = declarationsByClassName.get(className);
    if (!flat) {
      flat = declarationsIn(css);
      declarationsByClassName.set(className, flat);
    }
    for (const { path, property, value } of flat) {
      const key = path.join(" ");
      let group = byCondition.get(key);
      if (!group) {
        group = { path, props: new Map<string, string>() };
        byCondition.set(key, group);
        groups.push(group);
      }
      group.props.set(property, value);
    }
  }
  return groups;
};

const asMinMaxWidth = (segment: string): string => {
  const tidy = segment.trim().replace(/\s+/g, " ").replace(/'/g, '"');
  const query = /^@media \((.+)\)$/.exec(tidy)?.[1];
  if (query === undefined) return tidy;
  const canonical = query
    .replace(/^width\s*>=?\s*(.+)$/, "min-width: $1")
    .replace(/^width\s*<=?\s*(.+)$/, "max-width: $1")
    .replace(/\s*:\s*/, ": ");
  return `@media (${canonical})`;
};

const selectorAtoms = (suffix: string): string[] => {
  const atoms = suffix.match(/(?:::?[A-Za-z-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\])/g);
  if (atoms) return atoms;
  return suffix.trim() ? [suffix.trim()] : [];
};

const HOVER_MEDIA_QUERY = "@media (hover: hover)";

export const comparableCondition = (path: string[]): string => {
  const atRules: string[] = [];
  const atoms: string[] = [];
  for (const segment of path.map(asMinMaxWidth).filter(Boolean)) {
    if (segment === HOVER_MEDIA_QUERY) continue;
    if (segment.startsWith("@")) atRules.push(segment);
    else atoms.push(...selectorAtoms(segment));
  }
  return [...atRules.sort(), atoms.sort().join("")].filter(Boolean).join(" ");
};

const trimNum = (n: number): string => String(n).replace(/^0\./, ".");

const collapseWhitespace = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",");

const restoreLeadingZero = (v: string): string => v.replace(/(^|[\s,(/])0\.(\d)/g, "$1.$2");

const millisecondsToSeconds = (v: string): string =>
  v.replace(
    /(^|[\s,(])(\d*\.?\d+)ms\b/g,
    (_m, prefix: string, n: string) => `${prefix}${trimNum(Number(n) / 1000)}s`,
  );

const dropZeroUnits = (v: string): string =>
  v.replace(/(^|[\s,(])0(?:px|rem|em|%|vh|vw|s)\b/g, "$10");

const tightenSlashes = (v: string): string => v.replace(/\s*\/\s*/g, "/").replace(/;$/, "");

const unminified = (v: string): string =>
  tightenSlashes(dropZeroUnits(millisecondsToSeconds(restoreLeadingZero(collapseWhitespace(v)))));

const toKebabCase = (prop: string): string =>
  prop.startsWith("--") ? prop : prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

const asIs = (prop: string): string => prop;

const indexByCondition = (
  groups: DeclarationGroup[],
  keyOf: (prop: string) => string,
): DeclIndex => {
  const index: DeclIndex = new Map();
  for (const { path, props } of groups) {
    const condition = comparableCondition(path);
    const bucket = index.get(condition) ?? new Map<string, string>();
    index.set(condition, bucket);
    for (const [prop, value] of props) bucket.set(keyOf(prop), value);
  }
  return index;
};

const entriesOf = (index: DeclIndex): Array<[cond: string, property: string, value: string]> =>
  [...index].flatMap(([cond, props]) =>
    [...props].map(([property, value]): [string, string, string] => [cond, property, value]),
  );

const missingOrWrong = (styleName: string, expected: DeclIndex, actual: DeclIndex): Mismatch[] =>
  entriesOf(expected)
    .map(([cond, property, want]) => ({
      cond,
      property,
      want,
      got: actual.get(cond)?.get(property),
    }))
    .filter(({ want, got }) => got === undefined || unminified(got) !== unminified(want))
    .map(({ cond, property, want, got }) => ({
      styleName,
      condition: cond || "default",
      property,
      tailwind: want,
      stylex: got,
    }));

const unexpected = (styleName: string, expected: DeclIndex, actual: DeclIndex): Mismatch[] =>
  entriesOf(actual)
    .filter(([cond, property]) => expected.get(cond)?.has(property) !== true)
    .map(([cond, property, got]) => ({
      styleName,
      condition: cond || "default",
      property,
      tailwind: undefined,
      stylex: got,
    }));

export const compareStyle = (
  name: string,
  resolved: ResolvedClasses,
  rules: CompiledRule[],
): VerifyResult => {
  const expected = indexByCondition([...resolved.declarations.values()], toKebabCase);
  const actual = indexByCondition(declsFromRules(rules), asIs);
  const mismatches = [
    ...missingOrWrong(name, expected, actual),
    ...unexpected(name, expected, actual),
  ];

  if (mismatches.length > 0) return { ok: false, kind: "mismatch", mismatches, rules };
  return { ok: true, rules };
};

export const checkStyle = (name: string, resolved: ResolvedClasses, ns: Style): VerifyResult => {
  const compiled = compileStyleX(printCreate({ [name]: ns }));
  if ("error" in compiled) return { ok: false, kind: "compile-error", message: compiled.error };
  return compareStyle(name, resolved, compiled.rules);
};

const field = (node: unknown, key: string): unknown => (isRecord(node) ? node[key] : undefined);

const list = (node: unknown, key: string): unknown[] => {
  const value = field(node, key);
  return Array.isArray(value) ? value : [];
};

const stringValue = (node: unknown): string => {
  const value = field(node, "value");
  return typeof value === "string" ? value : "";
};

const nameOf = (node: unknown): string | undefined => {
  const identifier = field(node, "name");
  if (typeof identifier === "string") return identifier;
  const quoted = field(node, "value");
  return typeof quoted === "string" ? quoted : undefined;
};

const styleEntriesOf = (ast: unknown): unknown[] =>
  list(field(ast, "program"), "body")
    .flatMap(statement => list(statement, "declarations"))
    .flatMap(declarator => list(field(declarator, "init"), "properties"));

const atomicClassesOf = (styleEntry: unknown): string[] =>
  list(field(styleEntry, "value"), "properties")
    .filter(property => nameOf(field(property, "key")) !== "$$css")
    .flatMap(property => stringValue(field(property, "value")).split(" "))
    .filter(Boolean);

const classNamesByStyle = (ast: unknown): Map<string, string[]> => {
  const byStyle = new Map<string, string[]>();
  for (const entry of styleEntriesOf(ast)) {
    const name = nameOf(field(entry, "key"));
    if (name !== undefined) byStyle.set(name, atomicClassesOf(entry));
  }
  return byStyle;
};

export type BatchResult = { rules: Map<string, CompiledRule[]> } | { error: string };

const rulesByClassName = (metadata: unknown): Map<string, CompiledRule> => {
  const byClassName = new Map<string, CompiledRule>();
  for (const [className, rule, priority] of readMeta(metadata))
    byClassName.set(className, { className, css: rule.ltr, priority });
  return byClassName;
};

export const compileMany = (styles: Record<string, Style>): BatchResult => {
  const code = `import * as stylex from '@stylexjs/stylex';\n${printCreate(styles)}\nexport { styles };\n`;
  let res;
  try {
    res = babelTransform()(code, { ...babelOptions(), ast: true, code: false });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const ruleFor = rulesByClassName(res?.metadata);
  const classesOf = classNamesByStyle(res?.ast);
  const rules = new Map<string, CompiledRule[]>();
  for (const name of Object.keys(styles))
    rules.set(
      name,
      (classesOf.get(name) ?? []).flatMap(c => ruleFor.get(c) ?? []),
    );

  return { rules };
};
