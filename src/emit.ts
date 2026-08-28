import type { CondPath, Resolved } from "./reshape.ts";

/** A StyleX value: a leaf, or a condition object whose `default` may be null. */
export type SxValue = string | number | null | { [cond: string]: SxValue };
export type SxNamespace = Record<string, SxValue>;
type SxTree = { [cond: string]: SxValue };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

const isTree = (v: SxValue | undefined): v is SxTree => typeof v === "object" && v !== null;

/** Unitless numbers stay numbers; StyleX reads a bare number as px for length properties. */
const literal = (v: string): SxValue => (NUMERIC.test(v) ? Number(v) : v);

/**
 * StyleX allows one level of nesting inside a condition, so every selector fragment on a
 * path collapses into a single compound key while at-rules stay nested.
 * ['[data-disabled]', '[data-checked]', ':hover', '@media (hover: hover)']
 *   -> ['[data-disabled][data-checked]:hover', '@media (hover: hover)']
 */
export const canonicalPath = (path: CondPath): CondPath => {
  const selectors = path.filter(seg => !seg.startsWith("@"));
  const atRules = path.filter(seg => seg.startsWith("@"));
  const combined = selectors.join("");
  return combined ? [combined, ...atRules] : atRules;
};

const insert = (node: SxTree, path: CondPath, value: SxValue): void => {
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
  const child: SxTree = isTree(existing) ? existing : { default: existing ?? null };
  insert(child, rest, value);
  node[head] = child;
};

type Entry = { path: CondPath; value: string };

/** property -> every (condition path, value) that applies to it, in application order. */
const groupByProperty = (resolved: Resolved): Map<string, Entry[]> => {
  const byProp = new Map<string, Entry[]>();
  for (const { path: rawPath, props } of resolved.decls.values()) {
    const path = canonicalPath(rawPath);
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

const toValue = (entries: Entry[]): SxValue => {
  const flat = entries.find(e => e.path.length === 0);
  const conditional = entries.filter(e => e.path.length > 0);
  if (conditional.length === 0) return literal(flat?.value ?? "");

  const tree: SxTree = { default: flat ? literal(flat.value) : null };
  for (const { path, value } of conditional) insert(tree, path, literal(value));
  return tree;
};

/** Turn a resolved element into a single StyleX namespace object. */
export const toNamespace = (resolved: Resolved): SxNamespace => {
  const ns: SxNamespace = {};
  for (const [prop, entries] of groupByProperty(resolved)) ns[prop] = toValue(entries);
  return ns;
};

const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

const printValue = (value: SxValue, indent: number): string => {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return printObject(value, indent);
};

const printObject = (obj: SxTree | SxNamespace, indent: number): string => {
  const pad = " ".repeat(indent + 2);
  const lines = Object.entries(obj).map(
    entry => `${pad}${key(entry[0])}: ${printValue(entry[1], indent + 2)},`,
  );
  return `{\n${lines.join("\n")}\n${" ".repeat(indent)}}`;
};

/** Serialise namespaces to `stylex.create({...})` source. */
export const printCreate = (
  namespaces: Record<string, SxNamespace>,
  varName = "styles",
): string => {
  const body = Object.entries(namespaces)
    .map(entry => `  ${key(entry[0])}: ${printObject(entry[1], 2)},`)
    .join("\n");
  return `const ${varName} = stylex.create({\n${body}\n});`;
};
