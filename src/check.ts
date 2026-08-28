import { createRequire } from "node:module";

import postcss from "postcss";

import { cjsDefault, isRecord } from "./cjs.ts";
import type { ResolvedClasses } from "./classes-to-css.ts";
import { printCreate, type Style } from "./css-to-stylex.ts";

/**
 * Babel and the StyleX plugin are the slowest imports in the tool and only verification needs
 * them, so they are fetched at the moment of use. In a normal run that moment is inside the
 * verifier thread, and the main thread never loads them at all.
 */
const req = createRequire(import.meta.url);

type Transform = typeof import("@babel/core").transformSync;

type Babel = { transformSync: Transform; plugin: unknown };

const isTransform = (v: unknown): v is Transform => typeof v === "function";

let loaded: Babel | undefined;

const babel = (): Babel => {
  if (loaded) return loaded;
  const core: unknown = req("@babel/core");
  const mod: unknown = req("@stylexjs/babel-plugin");
  if (!isRecord(core) || !isTransform(core.transformSync))
    throw new Error("@babel/core did not provide transformSync.");

  const ready: Babel = {
    transformSync: core.transformSync,
    plugin: typeof mod === "function" ? mod : cjsDefault(mod),
  };
  loaded = ready;
  return ready;
};

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

const PLUGIN_OPTIONS = {
  dev: false,
  runtimeInjection: false,
  enableMinifiedKeys: false,
  enableMediaQueryOrder: KEEP_MEDIA_QUERIES_AS_IS,
  propertyValidationMode: REPORT_DROPPED_SHORTHANDS,
  unstable_moduleResolution: { type: "commonJS", rootDir: "/tw2sx" },
};

/**
 * Babel re-resolves its configuration whenever the options it is handed are a new object, and
 * this runs once per distinct class string. Hoisting the whole thing means one resolution for
 * the process instead of thousands.
 */
type TransformOptions = Parameters<Transform>[1];

let babelOptions: TransformOptions | undefined;

const optionsFor = (plugin: unknown): TransformOptions => {
  babelOptions ??= {
    filename: "/tw2sx/virtual.js",
    babelrc: false,
    configFile: false,
    plugins: [[plugin, PLUGIN_OPTIONS]],
  };
  return babelOptions;
};

export const compileStyleX = (source: string): { rules: CompiledRule[] } | { error: string } => {
  const code = `import * as stylex from '@stylexjs/stylex';\n${source}\nexport { styles };\n`;
  try {
    const { transformSync, plugin } = babel();
    const res = transformSync(code, optionsFor(plugin));
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

const conditionPart = (selector: string): string =>
  selector.replace(/^(\.[A-Za-z0-9_-]+)+/, "").replace(/:not\(#\\?#\)/g, "");

type FlatDecl = { path: string[]; property: string; value: string };

/**
 * An atomic rule is shared by every style that uses that declaration, so the same handful of
 * bytes would otherwise be parsed once per style. The class name is a hash of the rule, which
 * makes it a free cache key.
 */
const flatByClassName = new Map<string, FlatDecl[]>();

const flattenRule = (css: string): FlatDecl[] => {
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
    let flat = flatByClassName.get(className);
    if (!flat) {
      flat = flattenRule(css);
      flatByClassName.set(className, flat);
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

/**
 * StyleX charges per compile, not per style, so one call for the whole run costs about what a
 * dozen single calls do. The compiled object literal says which atomic classes each key ended up
 * with, which is what lets the rules be handed back to the style they came from.
 */
const classNamesByStyle = (ast: unknown): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const program = isRecord(ast) && isRecord(ast.program) ? ast.program : undefined;
  const body: unknown = program?.body;
  if (!Array.isArray(body)) return found;

  for (const statement of body) {
    const declarations = isRecord(statement) ? statement.declarations : undefined;
    if (!Array.isArray(declarations)) continue;
    for (const declarator of declarations) {
      const init = isRecord(declarator) ? declarator.init : undefined;
      if (!isRecord(init) || !Array.isArray(init.properties)) continue;
      for (const property of init.properties) readStyleEntry(property, found);
    }
  }
  return found;
};

const literalKey = (node: unknown): string | undefined => {
  if (!isRecord(node)) return undefined;
  if (typeof node.name === "string") return node.name;
  return typeof node.value === "string" ? node.value : undefined;
};

const readStyleEntry = (property: unknown, into: Map<string, string[]>): void => {
  if (!isRecord(property)) return;
  const name = literalKey(property.key);
  const value = property.value;
  if (name === undefined || !isRecord(value) || !Array.isArray(value.properties)) return;

  const classes: string[] = [];
  for (const entry of value.properties) {
    if (!isRecord(entry)) continue;
    if (literalKey(entry.key) === "$$css") continue;
    const literal = isRecord(entry.value) ? entry.value.value : undefined;
    if (typeof literal === "string") classes.push(...literal.split(" ").filter(Boolean));
  }
  into.set(name, classes);
};

export type BatchResult = { rules: Map<string, CompiledRule[]> } | { error: string };

export const compileMany = (styles: Record<string, Style>): BatchResult => {
  const code = `import * as stylex from '@stylexjs/stylex';\n${printCreate(styles)}\nexport { styles };\n`;
  let res;
  try {
    const { transformSync, plugin } = babel();
    res = transformSync(code, { ...optionsFor(plugin), ast: true, code: false });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const byClassName = new Map<string, CompiledRule>();
  for (const [className, rule, priority] of readMeta(res?.metadata))
    byClassName.set(className, { className, css: rule.ltr, priority });

  const owned = classNamesByStyle(res?.ast);
  const rules = new Map<string, CompiledRule[]>();
  for (const name of Object.keys(styles)) {
    const mine = owned.get(name) ?? [];
    rules.set(
      name,
      mine.flatMap(className => {
        const rule = byClassName.get(className);
        return rule ? [rule] : [];
      }),
    );
  }
  return { rules };
};
