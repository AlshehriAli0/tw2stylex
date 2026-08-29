import type { ConditionPath, ResolvedClasses } from "./classes-to-css.ts";

export type StyleValue = string | number | null | { [cond: string]: StyleValue };
export type Style = Record<string, StyleValue>;
type ConditionTree = { [cond: string]: StyleValue };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

const isTree = (v: StyleValue | undefined): v is ConditionTree =>
  typeof v === "object" && v !== null;

const literal = (v: string): StyleValue => (NUMERIC.test(v) ? Number(v) : v);

export const flattenConditions = (path: ConditionPath): ConditionPath => {
  const selectors = path.filter(seg => !seg.startsWith("@"));
  const atRules = path.filter(seg => seg.startsWith("@"));
  const combined = selectors.join("");
  return combined ? [combined, ...atRules] : atRules;
};

const insert = (node: ConditionTree, path: ConditionPath, value: StyleValue): void => {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const existing = node[head];

  if (rest.length === 0) {
    if (isTree(existing)) existing.default = value;
    else node[head] = value;
    return;
  }

  const branch: ConditionTree = isTree(existing) ? existing : { default: existing ?? null };
  insert(branch, rest, value);
  node[head] = branch;
};

type Entry = { path: ConditionPath; value: string };

const groupByProperty = (resolved: ResolvedClasses): Map<string, Entry[]> => {
  const byProp = new Map<string, Entry[]>();
  for (const { path: rawPath, props } of resolved.declarations.values()) {
    const path = flattenConditions(rawPath);
    const key = path.join(" ");
    for (const [prop, value] of props) {
      const entries = byProp.get(prop) ?? [];
      const sameCondition = entries.findIndex(e => e.path.join(" ") === key);
      if (sameCondition >= 0) entries[sameCondition] = { path, value };
      else entries.push({ path, value });
      byProp.set(prop, entries);
    }
  }
  return byProp;
};

const toValue = (entries: Entry[]): StyleValue => {
  const flat = entries.find(e => e.path.length === 0);
  const conditional = entries.filter(e => e.path.length > 0);
  if (conditional.length === 0) return literal(flat?.value ?? "");

  const tree: ConditionTree = { default: flat ? literal(flat.value) : null };
  for (const { path, value } of conditional) insert(tree, path, literal(value));
  return tree;
};

export const toStyle = (resolved: ResolvedClasses): Style => {
  const style: Style = {};
  for (const [prop, entries] of groupByProperty(resolved)) style[prop] = toValue(entries);
  return style;
};

const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

const printValue = (value: StyleValue, indent: number): string => {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return printObject(value, indent);
};

const printObject = (obj: ConditionTree | Style, indent: number): string => {
  const pad = " ".repeat(indent + 2);
  const lines = Object.entries(obj).map(
    entry => `${pad}${key(entry[0])}: ${printValue(entry[1], indent + 2)},`,
  );
  return `{\n${lines.join("\n")}\n${" ".repeat(indent)}}`;
};

export const printCreate = (styleMap: Record<string, Style>, varName = "styles"): string => {
  const body = Object.entries(styleMap)
    .map(([name, style]) => `  ${key(name)}: ${printObject(style, 2)},`)
    .join("\n");
  return `const ${varName} = stylex.create({\n${body}\n});`;
};

export type Declaration = { property: string; conditions: string[]; value: string | number | null };

export const declarationsOf = (style: Style): Declaration[] => {
  const flat: Declaration[] = [];

  const walk = (value: StyleValue, property: string, conditions: string[]): void => {
    if (isTree(value)) {
      for (const [cond, inner] of Object.entries(value))
        walk(inner, property, [...conditions, cond]);
      return;
    }
    flat.push({ property, conditions, value });
  };

  for (const [property, value] of Object.entries(style)) walk(value, property, []);
  return flat;
};

export const asStyle = ({ property, conditions, value }: Declaration): Style => {
  let nested: StyleValue = value;
  for (let i = conditions.length - 1; i >= 0; i -= 1) nested = { [conditions[i] ?? ""]: nested };
  return { [property]: nested };
};

export const declarationKey = ({ property, conditions, value }: Declaration): string =>
  JSON.stringify([property, conditions, value]);
