import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
import * as t from "@babel/types";

import { cjsDefault } from "./interop.ts";
import type { Refusal } from "./reshape.ts";

const isTraverse = (v: unknown): v is typeof traverseMod => typeof v === "function";
const unwrapped = cjsDefault(traverseMod);
const traverse = isTraverse(unwrapped) ? unwrapped : traverseMod;

export type Loc = { line: number; column: number };

export type SiteKind = "literal" | "cn-call" | "cva-base" | "cva-variant";

/** One place in a file where styles are applied. */
export type Site = {
  /** Static candidates we can resolve. */
  candidates: string[];
  loc: Loc;
  /** Byte range of the whole JSX attribute, for byte-preserving rewrites. */
  range?: [number, number];
  /** True when the attribute sits on a lowercase host element, so props can be spread. */
  hostElement?: boolean;
  kind: SiteKind;
  /** For cva sites: which axis/value this belongs to. */
  variantAxis?: string;
  variantValue?: string;
  /** Anything in the expression we could not statically read. */
  refusals: Refusal[];
};

export type FileScan = { sites: Site[]; hasStyleX: boolean };

const MERGE_FNS = new Set(["cn", "clsx", "classnames", "twMerge", "twJoin", "cx"]);

const locOf = (node: t.Node): Loc => ({
  line: node.loc?.start.line ?? 0,
  column: (node.loc?.start.column ?? 0) + 1,
});

const splitClasses = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** The static name of a property key, when it has one. */
const keyName = (key: t.Node): string | undefined => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return undefined;
};

/** The callee's plain name, for `cn(...)` and `utils.cn(...)` alike. */
const calleeName = (callee: t.Node): string => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name;
  return "";
};

type Reader = { classes: string[]; refusals: Refusal[] };

const dynamic = (node: t.Node, detail: string, hint: string): Refusal => ({
  reason: "dynamic-expression",
  detail: `${detail} at line ${locOf(node).line}.`,
  hint,
});

/** Classes read out of a branch whose parent already recorded the refusal. */
const classesOnly = (node: t.Node): string[] => readClasses(node).classes;

const TEMPLATE_HINT =
  "Lift the condition into a boolean and apply a separate StyleX namespace conditionally.";
const TERNARY_HINT =
  "Emit both branches as separate namespaces and select with the same condition.";
const LOGICAL_HINT = "Apply the namespace conditionally: stylex.props(base, cond && styles.x).";
const OBJECT_HINT = "Each key becomes a namespace applied under the same condition.";
const CALL_HINT =
  "Convert it by hand, or add it to the merge-function list if it behaves like clsx.";
const PROP_HINT = `Give the component a "style?: StyleXStylesWithout<{...}>" prop and pass it last to stylex.props(); see the skill's references/component-api.md.`;

/** A template literal contributes its static chunks; each interpolation is a refusal. */
const readTemplate = (n: t.TemplateLiteral, refusals: Refusal[]): string[] => {
  if (n.expressions.length > 0)
    refusals.push(
      dynamic(n, `Template literal with ${n.expressions.length} interpolation(s)`, TEMPLATE_HINT),
    );
  return n.quasis.flatMap(q => splitClasses(q.value.cooked ?? q.value.raw));
};

/** clsx({ 'a b': cond }) - the keys are the classes. */
const readObjectMap = (n: t.ObjectExpression, refusals: Refusal[]): string[] => {
  const classes = n.properties.flatMap(prop => {
    if (!t.isObjectProperty(prop)) return [];
    const key = keyName(prop.key);
    return key === undefined ? [] : splitClasses(key);
  });
  refusals.push(dynamic(n, "Object-form class map", OBJECT_HINT));
  return classes;
};

const readIdentifier = (n: t.Identifier, refusals: Refusal[]): string[] => {
  refusals.push({
    reason: "contract-change",
    detail: `Variable "${n.name}" flows into a class string at line ${locOf(n).line}.`,
    hint: PROP_HINT,
  });
  return [];
};

/**
 * Pull static class strings out of a className expression, recording a refusal for every
 * part we could not read statically.
 */
export const readClasses = (node: t.Node): Reader => {
  const refusals: Refusal[] = [];

  const walk = (n: t.Node): string[] => {
    if (t.isStringLiteral(n)) return splitClasses(n.value);
    if (t.isTemplateLiteral(n)) return readTemplate(n, refusals);
    if (t.isArrayExpression(n)) return n.elements.flatMap(e => (e ? walk(e) : []));
    if (t.isObjectExpression(n)) return readObjectMap(n, refusals);
    if (t.isIdentifier(n)) return readIdentifier(n, refusals);
    if (t.isCallExpression(n)) return walkCall(n);
    if (t.isConditionalExpression(n)) return walkTernary(n);
    if (t.isLogicalExpression(n)) return walkLogical(n);
    return [];
  };

  /** A known merge helper is transparent; anything else is opaque. */
  const walkCall = (n: t.CallExpression): string[] => {
    const name = calleeName(n.callee);
    if (MERGE_FNS.has(name)) return n.arguments.flatMap(a => walk(a));
    refusals.push(
      dynamic(
        n,
        `Call to ${name || "an expression"}() is not a known class-merging helper`,
        CALL_HINT,
      ),
    );
    return [];
  };

  const walkTernary = (n: t.ConditionalExpression): string[] => {
    refusals.push(dynamic(n, "Ternary in a class expression", TERNARY_HINT));
    return [...classesOnly(n.consequent), ...classesOnly(n.alternate)];
  };

  const walkLogical = (n: t.LogicalExpression): string[] => {
    refusals.push(dynamic(n, "Conditional (&&/||) class", LOGICAL_HINT));
    return classesOnly(n.right);
  };

  return { classes: walk(node), refusals };
};

/** The className/class attribute's value expression, if it has a readable one. */
const classExpression = (attr: t.JSXAttribute): t.Node | undefined => {
  if (!t.isJSXIdentifier(attr.name)) return undefined;
  if (attr.name.name !== "className" && attr.name.name !== "class") return undefined;
  const v = attr.value;
  if (t.isStringLiteral(v)) return v;
  if (t.isJSXExpressionContainer(v) && !t.isJSXEmptyExpression(v.expression)) return v.expression;
  return undefined;
};

/**
 * StyleX's no-conflicting-props: an element spreading stylex.props() must not also carry
 * its own style attribute - one of them silently loses.
 */
const styleAttrRefusal = (element: t.JSXOpeningElement): Refusal | undefined => {
  const styleAttr = element.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === "style",
  );
  if (!styleAttr) return undefined;
  return {
    reason: "conflicting-props",
    detail: `This element has both className and a style attribute (line ${locOf(styleAttr).line}).`,
    hint: "Fold the inline style into the StyleX namespace, or use a dynamic style function - an element cannot have both stylex.props() and a style prop.",
  };
};

const isHostElement = (element: t.JSXOpeningElement): boolean =>
  t.isJSXIdentifier(element.name) && /^[a-z]/.test(element.name.name);

const rangeOf = (node: t.Node): [number, number] | undefined =>
  node.start !== null && node.start !== undefined && node.end !== null && node.end !== undefined
    ? [node.start, node.end]
    : undefined;

const jsxSite = (
  attr: t.JSXAttribute,
  element: t.JSXOpeningElement | undefined,
): Site | undefined => {
  const expr = classExpression(attr);
  if (!expr) return undefined;

  const { classes, refusals } = readClasses(expr);
  const conflict = element ? styleAttrRefusal(element) : undefined;
  if (conflict) refusals.push(conflict);
  if (classes.length === 0 && refusals.length === 0) return undefined;

  return {
    candidates: classes,
    loc: locOf(attr),
    range: rangeOf(attr),
    hostElement: element ? isHostElement(element) : false,
    kind: t.isCallExpression(expr) ? "cn-call" : "literal",
    refusals,
  };
};

/** Every `variants: { axis: { value: "classes" } }` entry of a cva() config. */
/** Every `value: "classes"` pair under one variant axis. */
const axisSites = (variantAxis: string, values: t.ObjectExpression): Site[] =>
  values.properties.flatMap(value => {
    if (!t.isObjectProperty(value)) return [];
    const { classes, refusals } = readClasses(value.value);
    return [
      {
        candidates: classes,
        loc: locOf(value),
        kind: "cva-variant" as const,
        variantAxis,
        variantValue: keyName(value.key) ?? "",
        refusals,
      },
    ];
  });

const cvaVariantSites = (config: t.ObjectExpression): Site[] => {
  const variants = config.properties.find(
    (p): p is t.ObjectProperty => t.isObjectProperty(p) && keyName(p.key) === "variants",
  );
  if (!variants || !t.isObjectExpression(variants.value)) return [];

  return variants.value.properties.flatMap(axis =>
    t.isObjectProperty(axis) && t.isObjectExpression(axis.value)
      ? axisSites(keyName(axis.key) ?? "", axis.value)
      : [],
  );
};

const cvaSites = (call: t.CallExpression): Site[] => {
  const [base, config] = call.arguments;
  const sites: Site[] = [];

  if (base) {
    const { classes, refusals } = readClasses(base);
    sites.push({ candidates: classes, loc: locOf(call), kind: "cva-base", refusals });
  }
  if (config && t.isObjectExpression(config)) sites.push(...cvaVariantSites(config));
  return sites;
};

export const scanFile = (code: string, filename: string): FileScan => {
  const ast = parse(code, {
    sourceFilename: filename,
    sourceType: "module",
    plugins: ["jsx", "typescript", "decorators-legacy"],
    errorRecovery: true,
  });

  const sites: Site[] = [];
  let hasStyleX = false;

  traverse(ast, {
    ImportDeclaration(p) {
      if (p.node.source.value.startsWith("@stylexjs/")) hasStyleX = true;
    },
    JSXAttribute(p) {
      const parent = p.parentPath.node;
      const element = t.isJSXOpeningElement(parent) ? parent : undefined;
      const site = jsxSite(p.node, element);
      if (site) sites.push(site);
    },
    CallExpression(p) {
      if (calleeName(p.node.callee) === "cva") sites.push(...cvaSites(p.node));
    },
  });

  return { sites, hasStyleX };
};
