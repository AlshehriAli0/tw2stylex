import type { Resolved, CondPath } from './reshape.ts';

/** A StyleX value: a leaf, or a condition object whose `default` may be null. */
export type SxValue = string | number | null | { [cond: string]: SxValue };
export type SxNamespace = Record<string, SxValue>;

const isNumeric = (v: string) => /^-?\d+(\.\d+)?$/.test(v);

/** Turn a resolved element into a single StyleX namespace object. */
export function toNamespace(resolved: Resolved): SxNamespace {
  // property -> condition path -> value
  const byProp = new Map<string, { path: CondPath; value: string }[]>();
  for (const { path: rawPath, props } of resolved.decls.values()) {
    const path = canonicalPath(rawPath);
    for (const [prop, value] of props) {
      if (!byProp.has(prop)) byProp.set(prop, []);
      // Later writes win, so replace any earlier entry for the same condition path.
      const list = byProp.get(prop)!;
      const at = list.findIndex((e) => e.path.join(' ') === path.join(' '));
      if (at >= 0) list[at] = { path, value };
      else list.push({ path, value });
    }
  }

  const ns: SxNamespace = {};
  for (const [prop, entries] of byProp) {
    const flat = entries.find((e) => e.path.length === 0);
    const conditional = entries.filter((e) => e.path.length > 0);
    if (!conditional.length) {
      ns[prop] = lit(flat!.value);
      continue;
    }
    const tree: { [c: string]: SxValue } = { default: flat ? lit(flat.value) : null };
    for (const { path, value } of conditional) insert(tree, path, lit(value));
    ns[prop] = tree;
  }
  return ns;
}

function insert(node: { [c: string]: SxValue }, path: CondPath, value: SxValue) {
  const [head, ...rest] = path;
  if (!rest.length) {
    const existing = node[head];
    // Never clobber an already-nested branch with a scalar; keep it as that branch's default.
    if (existing && typeof existing === 'object') (existing as { [c: string]: SxValue }).default = value;
    else node[head] = value;
    return;
  }
  const existing = node[head];
  const child: { [c: string]: SxValue } =
    existing && typeof existing === 'object'
      ? (existing as { [c: string]: SxValue })
      : // A scalar already here is the value when only the outer condition holds.
        { default: existing === undefined ? null : existing };
  insert(child, rest, value);
  node[head] = child;
}

/**
 * StyleX allows only one level of nesting inside a condition, so every selector
 * fragment on a path collapses into a single compound key; at-rules stay nested.
 * ['[data-disabled]', '[data-checked]', ':hover', '@media (hover: hover)']
 *   -> ['[data-disabled][data-checked]:hover', '@media (hover: hover)']
 */
export function canonicalPath(path: CondPath): CondPath {
  const selectors: string[] = [];
  const atRules: string[] = [];
  for (const seg of path) (seg.startsWith('@') ? atRules : selectors).push(seg);
  const combined = selectors.join('');
  return combined ? [combined, ...atRules] : atRules;
}

const lit = (v: string): SxValue => (isNumeric(v) ? Number(v) : v);

/** Serialise a namespace map to `stylex.create({...})` source. */
export function printCreate(namespaces: Record<string, SxNamespace>, varName = 'styles'): string {
  const body = Object.entries(namespaces)
    .map(([name, ns]) => `  ${key(name)}: ${printObj(ns, 2)},`)
    .join('\n');
  return `const ${varName} = stylex.create({\n${body}\n});`;
}

function printObj(obj: Record<string, SxValue>, indent: number): string {
  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  const lines = Object.entries(obj).map(([k, v]) => `${pad}${key(k)}: ${printVal(v, indent + 2)},`);
  return `{\n${lines.join('\n')}\n${close}}`;
}

function printVal(v: SxValue, indent: number): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  return printObj(v, indent);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
