/**
 * The scanner reads an ESTree tree from oxc, which parses in a fraction of the time Babel takes
 * on the same files. ESTree names a few things differently from the Babel AST: one `Literal`
 * covers every literal, and object entries are `Property` rather than `ObjectProperty`.
 */
export type Node = { readonly [key: string]: unknown; readonly type: string };

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

export const is = (value: unknown, type: string): value is Node =>
  isNode(value) && value.type === type;

export const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

export const children = (node: Node, key: string): Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

export const text = (node: Node, key: string): string | undefined => {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
};

export const flag = (node: Node, key: string): boolean => node[key] === true;

export const span = (node: Node): [number, number] | undefined => {
  const { start, end } = node;
  return typeof start === "number" && typeof end === "number" ? [start, end] : undefined;
};

/** A `Literal` holding a string. ESTree does not separate string literals from any other kind. */
export const literalString = (node: unknown): string | undefined => {
  if (!is(node, "Literal")) return undefined;
  return typeof node.value === "string" ? node.value : undefined;
};

export const literalKey = (node: unknown): string | undefined => {
  if (is(node, "Identifier")) return text(node, "name");
  if (!is(node, "Literal")) return undefined;
  const { value } = node;
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : undefined;
};

/**
 * Positions, and the type annotations that make up much of a TSX tree. A type holds no element
 * and no call, so the parts of the file a scan cares about are never inside one.
 */
const SKIP = new Set([
  "type",
  "start",
  "end",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "returnType",
  "superTypeArguments",
]);

/**
 * Visits every node once, in document order, building nothing. Babel's `traverse` would attach a
 * path and a scope to each node so a visitor could rewrite the tree; the scanner only reads it.
 */
export const walk = (value: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isNode(value)) return;
  visit(value);
  for (const key of Object.keys(value)) {
    if (SKIP.has(key)) continue;
    walk(value[key], visit);
  }
};

/** Byte offsets are what the parser reports; a report needs a line and a column. */
export const lineFinder = (
  code: string,
): ((offset: number) => { line: number; column: number }) => {
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) if (code.charCodeAt(i) === 10) starts.push(i + 1);

  return offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
  };
};
