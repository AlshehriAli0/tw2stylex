import { parse } from "@babel/parser";
import * as t from "@babel/types";

import type { Skip } from "./skip.ts";

export type Loc = { line: number; column: number };

export type UsageKind = "literal" | "cn-call" | "cva-base" | "cva-variant";

export type Usage = {
  classNames: string[];
  loc: Loc;
  attributeRange?: [number, number];
  kind: UsageKind;
  variantAxis?: string;
  variantValue?: string;
  skips: Skip[];
};

export type ScanResult = { usages: Usage[]; hasStyleX: boolean };

const MERGE_FNS = new Set(["cn", "clsx", "classnames", "twMerge", "twJoin", "cx"]);

const looksLikeVariantFunction = (name: string): boolean => name.endsWith("Variants");

const locOf = (node: t.Node): Loc => ({
  line: node.loc?.start.line ?? 0,
  column: (node.loc?.start.column ?? 0) + 1,
});

const splitClasses = (s: string): string[] => s.split(/\s+/).filter(Boolean);

const keyName = (key: t.Node): string | undefined => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return undefined;
};

const propKey = (prop: t.ObjectProperty): string | undefined =>
  prop.computed ? undefined : keyName(prop.key);

const calleeName = (callee: t.Node): string => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name;
  return "";
};

type Reader = { classes: string[]; skips: Skip[] };

const dynamic = (node: t.Node, detail: string, hint: string): Skip => ({
  reason: "dynamic-classes",
  detail: `${detail} at line ${locOf(node).line}.`,
  hint,
});

const classesWithoutSkips = (node: t.Node): string[] => readClasses(node).classes;

const TEMPLATE_HINT =
  "Lift the condition into a boolean and apply a separate StyleX style conditionally.";
const TERNARY_HINT = "Write both branches as separate styles and pick one with the same condition.";
const LOGICAL_HINT = "Apply the style conditionally: stylex.props(base, cond && styles.x).";
const OBJECT_HINT = "Each key becomes a style applied under the same condition.";
const CALL_HINT =
  "Convert it by hand, or add it to the merge-function list if it behaves like clsx.";
const EXPRESSION_HINT =
  "Rewrite the runtime expression as conditional StyleX styles before removing className.";
const PROP_HINT = `Give the component a "style?: StyleXStylesWithout<{...}>" prop and pass it last to stylex.props(); see the skill's references/component-api.md.`;

const readTemplate = (n: t.TemplateLiteral, skips: Skip[]): string[] => {
  if (n.expressions.length > 0)
    skips.push(
      dynamic(n, `Template literal with ${n.expressions.length} interpolation(s)`, TEMPLATE_HINT),
    );
  return n.quasis.flatMap(q => splitClasses(q.value.cooked ?? q.value.raw));
};

const readObjectMap = (n: t.ObjectExpression, skips: Skip[]): string[] => {
  const classes = n.properties.flatMap(prop => {
    if (!t.isObjectProperty(prop)) return [];
    const key = propKey(prop);
    return key === undefined ? [] : splitClasses(key);
  });
  skips.push(dynamic(n, "Object-form class map", OBJECT_HINT));
  return classes;
};

const readIdentifier = (n: t.Identifier, skips: Skip[]): string[] => {
  skips.push({
    reason: "passed-in-classes",
    detail: `Variable "${n.name}" flows into a class string at line ${locOf(n).line}.`,
    hint: PROP_HINT,
  });
  return [];
};

export const readClasses = (node: t.Node): Reader => {
  const skips: Skip[] = [];

  const written = (n: t.Node): string[] | undefined => {
    if (t.isStringLiteral(n)) return splitClasses(n.value);
    if (t.isTemplateLiteral(n)) return readTemplate(n, skips);
    if (t.isArrayExpression(n)) return n.elements.flatMap(e => (e ? walk(e) : []));
    if (t.isObjectExpression(n)) return readObjectMap(n, skips);
    return undefined;
  };

  const decidedAtRuntime = (n: t.Node): string[] | undefined => {
    if (t.isIdentifier(n)) return readIdentifier(n, skips);
    if (t.isCallExpression(n)) return walkCall(n);
    if (t.isConditionalExpression(n)) return walkTernary(n);
    if (t.isLogicalExpression(n)) return walkLogical(n);
    return undefined;
  };

  const unsupported = (n: t.Node): string[] => {
    skips.push(dynamic(n, `${n.type} in a class expression`, EXPRESSION_HINT));
    return [];
  };

  const walk = (n: t.Node): string[] => written(n) ?? decidedAtRuntime(n) ?? unsupported(n);

  const walkCall = (n: t.CallExpression): string[] => {
    const name = calleeName(n.callee);
    if (MERGE_FNS.has(name)) return n.arguments.flatMap(a => walk(a));

    if (looksLikeVariantFunction(name)) {
      skips.push({
        reason: "variant-function",
        detail: `${name}() looks like a cva() variant function defined in another file.`,
        hint: `Run tw2sx plan over the file that defines ${name} as well - its styles are converted there.`,
      });
      return [];
    }

    skips.push(
      dynamic(
        n,
        `Call to ${name || "an expression"}() is not a known class-merging helper`,
        CALL_HINT,
      ),
    );
    return [];
  };

  const walkTernary = (n: t.ConditionalExpression): string[] => {
    skips.push(dynamic(n, "Ternary in a class expression", TERNARY_HINT));
    return [...classesWithoutSkips(n.consequent), ...classesWithoutSkips(n.alternate)];
  };

  const walkLogical = (n: t.LogicalExpression): string[] => {
    skips.push(dynamic(n, "Conditional (&&/||) class", LOGICAL_HINT));
    return classesWithoutSkips(n.right);
  };

  return { classes: walk(node), skips };
};

const classExpression = (attr: t.JSXAttribute): t.Node | undefined => {
  if (!t.isJSXIdentifier(attr.name)) return undefined;
  if (attr.name.name !== "className" && attr.name.name !== "class") return undefined;
  const v = attr.value;
  if (t.isStringLiteral(v)) return v;
  if (t.isJSXExpressionContainer(v) && !t.isJSXEmptyExpression(v.expression)) return v.expression;
  return undefined;
};

const styleAttrSkip = (element: t.JSXOpeningElement | undefined): Skip | undefined => {
  const styleAttr = element?.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === "style",
  );
  if (!styleAttr) return undefined;
  return {
    reason: "two-style-sources",
    detail: `This element has both className and a style attribute (line ${locOf(styleAttr).line}).`,
    hint: "Fold the inline style into the StyleX style, or use a dynamic style function - an element cannot have both stylex.props() and a style prop.",
  };
};

const isHostElement = (element: t.JSXOpeningElement): boolean =>
  t.isJSXIdentifier(element.name) && /^[a-z]/.test(element.name.name);

const componentSkip = (element: t.JSXOpeningElement | undefined): Skip | undefined =>
  element && isHostElement(element)
    ? undefined
    : {
        reason: "component-class-name",
        detail: "This className is on a component, not a host element.",
        hint: "Convert the component first, then pass a StyleX style prop instead of className.",
      };

const rangeOf = (node: t.Node): [number, number] | undefined =>
  node.start !== null && node.start !== undefined && node.end !== null && node.end !== undefined
    ? [node.start, node.end]
    : undefined;

const jsxUsage = (
  attr: t.JSXAttribute,
  element: t.JSXOpeningElement | undefined,
): Usage | undefined => {
  const expr = classExpression(attr);
  if (!expr) return undefined;

  const { classes, skips } = readClasses(expr);
  const styleAttr = styleAttrSkip(element);
  if (styleAttr) skips.push(styleAttr);
  if (classes.length === 0 && skips.length === 0) return undefined;

  const onComponent = componentSkip(element);
  if (onComponent) skips.push(onComponent);

  return {
    classNames: classes,
    loc: locOf(attr),
    attributeRange: rangeOf(attr),
    kind: t.isCallExpression(expr) ? "cn-call" : "literal",
    skips,
  };
};

const axisUsages = (variantAxis: string, values: t.ObjectExpression): Usage[] =>
  values.properties.flatMap(value => {
    if (!t.isObjectProperty(value)) return [];
    const { classes, skips } = readClasses(value.value);
    return [
      {
        classNames: classes,
        loc: locOf(value),
        kind: "cva-variant" as const,
        variantAxis,
        variantValue: propKey(value) ?? "",
        skips,
      },
    ];
  });

const cvaVariantUsages = (config: t.ObjectExpression): Usage[] => {
  const variants = config.properties.find(
    (p): p is t.ObjectProperty => t.isObjectProperty(p) && propKey(p) === "variants",
  );
  if (!variants || !t.isObjectExpression(variants.value)) return [];

  return variants.value.properties.flatMap(axis =>
    t.isObjectProperty(axis) && t.isObjectExpression(axis.value)
      ? axisUsages(propKey(axis) ?? "", axis.value)
      : [],
  );
};

const cvaUsages = (call: t.CallExpression): Usage[] => {
  const [base, config] = call.arguments;
  const usages: Usage[] = [];

  if (base) {
    const { classes, skips } = readClasses(base);
    usages.push({ classNames: classes, loc: locOf(call), kind: "cva-base", skips });
  }
  if (config && t.isObjectExpression(config)) usages.push(...cvaVariantUsages(config));
  return usages;
};

const COULD_HOLD_A_USAGE = /className|class\s*=|\bcva\s*\(|@stylexjs\//;

export const scanFile = (code: string, filename: string): ScanResult => {
  if (!COULD_HOLD_A_USAGE.test(code)) return { usages: [], hasStyleX: false };

  const ast = parse(code, {
    sourceFilename: filename,
    sourceType: "module",
    plugins: ["jsx", "typescript", "decorators-legacy"],
    errorRecovery: true,
  });

  const usages: Usage[] = [];
  let hasStyleX = false;
  const elementOf = new Map<t.JSXAttribute, t.JSXOpeningElement>();

  const claimAttributes = (element: t.JSXOpeningElement): void => {
    for (const attr of element.attributes) if (t.isJSXAttribute(attr)) elementOf.set(attr, element);
  };

  const readAttribute = (attr: t.JSXAttribute): void => {
    const usage = jsxUsage(attr, elementOf.get(attr));
    if (usage) usages.push(usage);
  };

  const readCva = (call: t.CallExpression): void => {
    if (calleeName(call.callee) === "cva") usages.push(...cvaUsages(call));
  };

  const readImport = (declaration: t.ImportDeclaration): void => {
    if (declaration.source.value.startsWith("@stylexjs/")) hasStyleX = true;
  };

  t.traverseFast(ast, node => {
    if (t.isJSXOpeningElement(node)) claimAttributes(node);
    else if (t.isJSXAttribute(node)) readAttribute(node);
    else if (t.isCallExpression(node)) readCva(node);
    else if (t.isImportDeclaration(node)) readImport(node);
  });

  return { usages, hasStyleX };
};
