import { parseSync, rawTransferSupported, type ParserOptions } from "oxc-parser";

import {
  child,
  children,
  flag,
  is,
  lineFinder,
  literalKey,
  literalString,
  span,
  text,
  walk as walkTree,
  type Node,
} from "./estree.ts";
import type { Skip } from "./skip.ts";

export type Loc = { line: number; column: number };

export type UsageKind = "literal" | "cn-call" | "cva-base" | "cva-variant";

export type Usage = {
  classNames: string[];
  loc: Loc;
  attributeRange?: [number, number];
  onHostElement?: boolean;
  kind: UsageKind;
  variantAxis?: string;
  variantValue?: string;
  skips: Skip[];
};

export type ScanResult = { usages: Usage[]; hasStyleX: boolean };

const MERGE_FNS = new Set(["cn", "clsx", "classnames", "twMerge", "twJoin", "cx"]);

const looksLikeVariantFunction = (name: string): boolean => name.endsWith("Variants");

const splitClasses = (s: string): string[] => s.split(/\s+/).filter(Boolean);

const propKey = (prop: Node): string | undefined =>
  flag(prop, "computed") ? undefined : literalKey(prop.key);

const calleeName = (callee: Node | undefined): string => {
  if (!callee) return "";
  if (is(callee, "Identifier")) return text(callee, "name") ?? "";
  if (is(callee, "MemberExpression")) {
    const property = child(callee, "property");
    if (property && is(property, "Identifier")) return text(property, "name") ?? "";
  }
  return "";
};

type Reader = { classes: string[]; skips: Skip[] };

const TEMPLATE_HINT =
  "Lift the condition into a boolean and apply a separate StyleX style conditionally.";
const TERNARY_HINT = "Write both branches as separate styles and pick one with the same condition.";
const LOGICAL_HINT = "Apply the style conditionally: stylex.props(base, cond && styles.x).";
const OBJECT_HINT = "Each key becomes a style applied under the same condition.";
const CALL_HINT =
  "Convert it by hand, or add it to the merge-function list if it behaves like clsx.";
const PROP_HINT = `Give the component a "style?: StyleXStylesWithout<{...}>" prop and pass it last to stylex.props(); see the skill's references/component-api.md.`;

/**
 * Everything a scan reports carries a line, and the parser reports byte offsets, so one line
 * index per file is built up front and every lookup is a binary search against it.
 */
type Reading = { lineAt: (offset: number) => Loc; skips: Skip[] };

const locOf = (r: Reading, node: Node): Loc => {
  const range = span(node);
  return range ? r.lineAt(range[0]) : { line: 0, column: 0 };
};

const dynamic = (r: Reading, node: Node, detail: string, hint: string): Skip => ({
  reason: "dynamic-classes",
  detail: `${detail} at line ${locOf(r, node).line}.`,
  hint,
});

/** A template chunk carries its text under `value`, cooked unless the escape made that impossible. */
const quasiText = (quasi: Node): string => {
  const value = quasi.value;
  if (typeof value !== "object" || value === null) return "";
  const { cooked, raw } = value as { cooked?: unknown; raw?: unknown };
  if (typeof cooked === "string") return cooked;
  return typeof raw === "string" ? raw : "";
};

const readTemplate = (r: Reading, n: Node): string[] => {
  const expressions = children(n, "expressions");
  if (expressions.length > 0)
    r.skips.push(
      dynamic(r, n, `Template literal with ${expressions.length} interpolation(s)`, TEMPLATE_HINT),
    );
  return children(n, "quasis").flatMap(q => splitClasses(quasiText(q)));
};

const readObjectMap = (r: Reading, n: Node): string[] => {
  const classes = children(n, "properties").flatMap(prop => {
    if (!is(prop, "Property")) return [];
    const key = propKey(prop);
    return key === undefined ? [] : splitClasses(key);
  });
  r.skips.push(dynamic(r, n, "Object-form class map", OBJECT_HINT));
  return classes;
};

const readIdentifier = (r: Reading, n: Node): string[] => {
  r.skips.push({
    reason: "passed-in-classes",
    detail: `Variable "${text(n, "name") ?? ""}" flows into a class string at line ${locOf(r, n).line}.`,
    hint: PROP_HINT,
  });
  return [];
};

const readWith = (r: Reading, node: Node): string[] => {
  const literal = literalString(node);
  if (literal !== undefined) return splitClasses(literal);
  if (is(node, "TemplateLiteral")) return readTemplate(r, node);
  if (is(node, "ArrayExpression")) return children(node, "elements").flatMap(e => readWith(r, e));
  if (is(node, "ObjectExpression")) return readObjectMap(r, node);
  if (is(node, "Identifier")) return readIdentifier(r, node);
  if (is(node, "CallExpression")) return readCall(r, node);
  if (is(node, "ConditionalExpression")) return readTernary(r, node);
  if (is(node, "LogicalExpression")) return readLogical(r, node);
  return [];
};

const quietly = (node: Node | undefined, lineAt: Reading["lineAt"]): string[] =>
  node ? readWith({ lineAt, skips: [] }, node) : [];

const readCall = (r: Reading, n: Node): string[] => {
  const name = calleeName(child(n, "callee"));
  if (MERGE_FNS.has(name)) return children(n, "arguments").flatMap(a => readWith(r, a));

  if (looksLikeVariantFunction(name)) {
    r.skips.push({
      reason: "variant-function",
      detail: `${name}() looks like a cva() variant function defined in another file.`,
      hint: `Run tw2sx plan over the file that defines ${name} as well - its styles are converted there.`,
    });
    return [];
  }

  r.skips.push(
    dynamic(
      r,
      n,
      `Call to ${name || "an expression"}() is not a known class-merging helper`,
      CALL_HINT,
    ),
  );
  return [];
};

const readTernary = (r: Reading, n: Node): string[] => {
  r.skips.push(dynamic(r, n, "Ternary in a class expression", TERNARY_HINT));
  return [
    ...quietly(child(n, "consequent"), r.lineAt),
    ...quietly(child(n, "alternate"), r.lineAt),
  ];
};

const readLogical = (r: Reading, n: Node): string[] => {
  r.skips.push(dynamic(r, n, "Conditional (&&/||) class", LOGICAL_HINT));
  return quietly(child(n, "right"), r.lineAt);
};

export const readClasses = (node: Node, lineAt: Reading["lineAt"]): Reader => {
  const r: Reading = { lineAt, skips: [] };
  return { classes: readWith(r, node), skips: r.skips };
};

const attributeName = (attr: Node): string | undefined => {
  const name = child(attr, "name");
  return name && is(name, "JSXIdentifier") ? text(name, "name") : undefined;
};

const classExpression = (attr: Node): Node | undefined => {
  const name = attributeName(attr);
  if (name !== "className" && name !== "class") return undefined;

  const value = child(attr, "value");
  if (!value) return undefined;
  if (literalString(value) !== undefined) return value;
  if (!is(value, "JSXExpressionContainer")) return undefined;

  const inner = child(value, "expression");
  return inner && !is(inner, "JSXEmptyExpression") ? inner : undefined;
};

const styleAttrSkip = (r: Reading, element: Node): Skip | undefined => {
  const styleAttr = children(element, "attributes").find(
    a => is(a, "JSXAttribute") && attributeName(a) === "style",
  );
  if (!styleAttr) return undefined;
  return {
    reason: "two-style-sources",
    detail: `This element has both className and a style attribute (line ${locOf(r, styleAttr).line}).`,
    hint: "Fold the inline style into the StyleX style, or use a dynamic style function - an element cannot have both stylex.props() and a style prop.",
  };
};

const isHostElement = (element: Node): boolean => {
  const name = child(element, "name");
  if (!name || !is(name, "JSXIdentifier")) return false;
  return /^[a-z]/.test(text(name, "name") ?? "");
};

const jsxUsage = (
  attr: Node,
  element: Node | undefined,
  lineAt: Reading["lineAt"],
): Usage | undefined => {
  const expr = classExpression(attr);
  if (!expr) return undefined;

  const r: Reading = { lineAt, skips: [] };
  const classes = readWith(r, expr);
  const conflict = element ? styleAttrSkip(r, element) : undefined;
  if (conflict) r.skips.push(conflict);
  if (classes.length === 0 && r.skips.length === 0) return undefined;

  return {
    classNames: classes,
    loc: locOf(r, attr),
    attributeRange: span(attr),
    onHostElement: element ? isHostElement(element) : false,
    kind: is(expr, "CallExpression") ? "cn-call" : "literal",
    skips: r.skips,
  };
};

const axisUsages = (variantAxis: string, values: Node, lineAt: Reading["lineAt"]): Usage[] =>
  children(values, "properties").flatMap(value => {
    if (!is(value, "Property")) return [];
    const inner = child(value, "value");
    const r: Reading = { lineAt, skips: [] };
    const classes = inner ? readWith(r, inner) : [];
    return [
      {
        classNames: classes,
        loc: locOf(r, value),
        kind: "cva-variant" as const,
        variantAxis,
        variantValue: propKey(value) ?? "",
        skips: r.skips,
      },
    ];
  });

const cvaVariantUsages = (config: Node, lineAt: Reading["lineAt"]): Usage[] => {
  const variants = children(config, "properties").find(
    p => is(p, "Property") && propKey(p) === "variants",
  );
  const axes = variants ? child(variants, "value") : undefined;
  if (!axes || !is(axes, "ObjectExpression")) return [];

  return children(axes, "properties").flatMap(axis => {
    const values = is(axis, "Property") ? child(axis, "value") : undefined;
    return values && is(values, "ObjectExpression")
      ? axisUsages(propKey(axis) ?? "", values, lineAt)
      : [];
  });
};

const cvaUsages = (call: Node, lineAt: Reading["lineAt"]): Usage[] => {
  const [base, config] = children(call, "arguments");
  const usages: Usage[] = [];

  if (base) {
    const r: Reading = { lineAt, skips: [] };
    const classes = readWith(r, base);
    usages.push({ classNames: classes, loc: locOf(r, call), kind: "cva-base", skips: r.skips });
  }
  if (config && is(config, "ObjectExpression")) usages.push(...cvaVariantUsages(config, lineAt));
  return usages;
};

/**
 * Half of a real codebase is hooks, types and utilities with no styling in them at all. Parsing
 * those costs more than reading them. Anything this misses is a file that could not have held a
 * usage, because a usage only ever comes from a class attribute or a cva() call.
 */
const MIGHT_STYLE = /className|class\s*=|\bcva\s*\(|@stylexjs\//;

/**
 * Reads the parser's own buffer instead of serialising the tree through JSON, which is most of
 * what parsing a file costs. It throws outright where it is unsupported — 32-bit, big-endian,
 * older runtimes, and bun — so the runtime is asked first and the ordinary tree is used
 * otherwise: slower, identical output. Nothing here outlives the scan, so the buffer's lifetime
 * never becomes the caller's problem.
 */
type RawTransfer = ParserOptions & { experimentalRawTransfer?: boolean };

const PARSE: RawTransfer = rawTransferSupported() ? { experimentalRawTransfer: true } : {};

export const scanFile = (code: string, filename: string): ScanResult => {
  if (!MIGHT_STYLE.test(code)) return { usages: [], hasStyleX: false };

  const { program } = parseSync(filename, code, PARSE);
  const lineAt = lineFinder(code);

  const usages: Usage[] = [];
  let hasStyleX = false;

  /**
   * Attributes are noted down by their element on the way past and handled where the walk reaches
   * them, which keeps the usages in document order even when an attribute value holds another
   * element. Numbering in the generated output follows that order.
   */
  const elementOf = new Map<Node, Node>();

  walkTree(program, node => {
    if (is(node, "JSXOpeningElement")) {
      for (const attr of children(node, "attributes"))
        if (is(attr, "JSXAttribute")) elementOf.set(attr, node);
    } else if (is(node, "JSXAttribute")) {
      const usage = jsxUsage(node, elementOf.get(node), lineAt);
      if (usage) usages.push(usage);
    } else if (is(node, "CallExpression")) {
      if (calleeName(child(node, "callee")) === "cva") usages.push(...cvaUsages(node, lineAt));
    } else if (is(node, "ImportDeclaration")) {
      const source = child(node, "source");
      if ((source ? literalString(source) : undefined)?.startsWith("@stylexjs/") === true)
        hasStyleX = true;
    }
  });

  return { usages, hasStyleX };
};
