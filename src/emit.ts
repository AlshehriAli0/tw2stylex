import type { ConditionPath, ResolvedClasses } from "./reshape.ts";

/** A StyleX value: a leaf, or a condition object whose `default` may be null. */
export type StyleValue = string | number | null | { [cond: string]: StyleValue };
export type Style = Record<string, StyleValue>;
type ConditionTree = { [cond: string]: StyleValue };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

const isTree = (v: StyleValue | undefined): v is ConditionTree =>
  typeof v === "object" && v !== null;

/** Unitless numbers stay numbers; StyleX reads a bare number as px for length properties. */
const literal = (v: string): StyleValue => (NUMERIC.test(v) ? Number(v) : v);

/**
 * StyleX allows one level of nesting inside a condition, so every selector fragment on a
 * path collapses into a single compound key while at-rules stay nested.
 * ['[data-disabled]', '[data-checked]', ':hover', '@media (hover: hover)']
 *   -> ['[data-disabled][data-checked]:hover', '@media (hover: hover)']
 */
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
    // Never clobber an already-nested branch with a scalar; it becomes that branch's default.
    if (isTree(existing)) existing.default = value;
    else node[head] = value;
    return;
  }

  // A scalar already here is the value for when only the outer condition holds.
  const child: ConditionTree = isTree(existing) ? existing : { default: existing ?? null };
  insert(child, rest, value);
  node[head] = child;
};

type Entry = { path: ConditionPath; value: string };

/** property -> every (condition path, value) that applies to it, in application order. */
const groupByProperty = (resolved: ResolvedClasses): Map<string, Entry[]> => {
  const byProp = new Map<string, Entry[]>();
  for (const { path: rawPath, props } of resolved.declarations.values()) {
    const path = flattenConditions(rawPath);
    const key = path.join(" ");
    for (const [prop, value] of props) {
      const entries = byProp.get(prop) ?? [];
      // Later writes win, so replace any earlier entry for the same condition path.
      const at = entries.findIndex(e => e.path.join(" ") === key);
      if (at >= 0) entries[at] = { path, value };
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

/** Turn resolved declarations into one StyleX style object. */
export const toStyle = (resolved: ResolvedClasses): Style => {
  const ns: Style = {};
  for (const [prop, entries] of groupByProperty(resolved)) ns[prop] = toValue(entries);
  return ns;
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

/** Serialise styles to `stylex.create({...})` source. */
export const printCreate = (styleMap: Record<string, Style>, varName = "styles"): string => {
  const body = Object.entries(styleMap)
    .map(([name, style]) => `  ${key(name)}: ${printObject(style, 2)},`)
    .join("\n");
  return `const ${varName} = stylex.create({\n${body}\n});`;
};
