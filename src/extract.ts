import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { Refusal } from './reshape.ts';

// @babel/traverse ships CJS-first; unwrap the interop default.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export type Loc = { line: number; column: number };

/** One place in a file where styles are applied. */
export type Site = {
  /** Static candidates we can resolve. */
  candidates: string[];
  loc: Loc;
  /** Byte range of the whole JSX attribute, for byte-preserving rewrites. */
  range?: [number, number];
  /** True when the attribute sits on a lowercase host element (so props can be spread). */
  hostElement?: boolean;
  /** How the class string was written, for the report and for rewriting later. */
  kind: 'literal' | 'cn-call' | 'cva-base' | 'cva-variant';
  /** For cva sites: which axis/value this belongs to. */
  variantAxis?: string;
  variantValue?: string;
  /** Anything in the expression we could not statically read. */
  refusals: Refusal[];
};

export type FileScan = { sites: Site[]; hasStyleX: boolean };

const MERGE_FNS = new Set(['cn', 'clsx', 'classnames', 'twMerge', 'twJoin', 'cx']);

const locOf = (node: t.Node): Loc => ({
  line: node.loc?.start.line ?? 0,
  column: (node.loc?.start.column ?? 0) + 1,
});

const splitClasses = (s: string) => s.split(/\s+/).filter(Boolean);

export function scanFile(code: string, filename: string): FileScan {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: [filename.endsWith('.tsx') || filename.endsWith('.jsx') ? 'jsx' : 'jsx', 'typescript', 'decorators-legacy'],
    errorRecovery: true,
  });

  const sites: Site[] = [];
  let hasStyleX = false;

  /** Pull static class strings out of an expression, refusing what we cannot read. */
  function readClasses(node: t.Node, refusals: Refusal[]): string[] {
    if (t.isStringLiteral(node)) return splitClasses(node.value);
    if (t.isTemplateLiteral(node)) {
      if (node.expressions.length) {
        refusals.push({
          reason: 'dynamic-expression',
          detail: `Template literal with ${node.expressions.length} interpolation(s) at line ${locOf(node).line}.`,
          hint: 'Lift the condition into a boolean and apply a separate StyleX namespace conditionally.',
        });
      }
      return node.quasis.flatMap((q) => splitClasses(q.value.cooked ?? q.value.raw));
    }
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      const name = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : '';
      if (MERGE_FNS.has(name)) return node.arguments.flatMap((a) => readClasses(a as t.Node, refusals));
      refusals.push({
        reason: 'dynamic-expression',
        detail: `Call to ${name || 'an expression'}() at line ${locOf(node).line} is not a known class-merging helper.`,
        hint: 'Convert it by hand, or add it to the merge-function list if it behaves like clsx.',
      });
      return [];
    }
    if (t.isConditionalExpression(node)) {
      refusals.push({
        reason: 'dynamic-expression',
        detail: `Ternary in a class expression at line ${locOf(node).line}.`,
        hint: 'Emit both branches as separate namespaces and select with the same condition.',
      });
      return [...readClasses(node.consequent, []), ...readClasses(node.alternate, [])];
    }
    if (t.isLogicalExpression(node)) {
      refusals.push({
        reason: 'dynamic-expression',
        detail: `Conditional (&&/||) class at line ${locOf(node).line}.`,
        hint: 'Apply the namespace conditionally: stylex.props(base, cond && styles.x).',
      });
      return readClasses(node.right, []);
    }
    if (t.isObjectExpression(node)) {
      // clsx({ 'a b': cond }) - keys are the classes.
      const out: string[] = [];
      for (const p of node.properties) {
        if (t.isObjectProperty(p)) {
          const k = t.isStringLiteral(p.key) ? p.key.value : t.isIdentifier(p.key) ? p.key.name : null;
          if (k) out.push(...splitClasses(k));
        }
      }
      refusals.push({
        reason: 'dynamic-expression',
        detail: `Object-form class map at line ${locOf(node).line}.`,
        hint: 'Each key becomes a namespace applied under the same condition.',
      });
      return out;
    }
    if (t.isArrayExpression(node)) return node.elements.flatMap((e) => (e ? readClasses(e as t.Node, refusals) : []));
    if (t.isIdentifier(node)) {
      refusals.push({
        reason: 'contract-change',
        detail: `Variable "${node.name}" flows into a class string at line ${locOf(node).line}.`,
        hint: `Give the component a "style?: StyleXStylesWithout<{...}>" prop and pass it last to stylex.props(); see the skill's references/component-api.md.`,
      });
      return [];
    }
    return [];
  }

  traverse(ast, {
    ImportDeclaration(p) {
      if (p.node.source.value.startsWith('@stylexjs/')) hasStyleX = true;
    },
    JSXAttribute(p) {
      const n = p.node;
      if (!t.isJSXIdentifier(n.name) || (n.name.name !== 'className' && n.name.name !== 'class')) return;
      const v = n.value;
      const refusals: Refusal[] = [];
      let expr: t.Node | null = null;
      if (t.isStringLiteral(v)) expr = v;
      else if (t.isJSXExpressionContainer(v) && !t.isJSXEmptyExpression(v.expression)) expr = v.expression;
      if (!expr) return;
      const candidates = readClasses(expr, refusals);
      if (!candidates.length && !refusals.length) return;
      const parent = p.parentPath?.node;
      const tag = parent && t.isJSXOpeningElement(parent) ? parent.name : null;
      // StyleX's no-conflicting-props: an element spreading stylex.props() must not also
      // carry its own style/className attribute - one of them silently loses.
      if (parent && t.isJSXOpeningElement(parent)) {
        for (const attr of parent.attributes) {
          if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'style')
            refusals.push({
              reason: 'conflicting-props',
              detail: `This element has both className and a style attribute (line ${locOf(attr).line}).`,
              hint: 'Fold the inline style into the StyleX namespace, or keep it as a dynamic style function - an element cannot have both stylex.props() and a style prop.',
            });
        }
      }
      sites.push({
        candidates,
        loc: locOf(n),
        range: n.start != null && n.end != null ? [n.start, n.end] : undefined,
        hostElement: !!(tag && t.isJSXIdentifier(tag) && /^[a-z]/.test(tag.name)),
        kind: t.isCallExpression(expr) ? 'cn-call' : 'literal',
        refusals,
      });
    },
    CallExpression(p) {
      const callee = p.node.callee;
      if (!t.isIdentifier(callee) || callee.name !== 'cva') return;
      const [base, config] = p.node.arguments;
      if (base) {
        const refusals: Refusal[] = [];
        const candidates = readClasses(base as t.Node, refusals);
        sites.push({ candidates, loc: locOf(p.node), kind: 'cva-base', refusals });
      }
      if (config && t.isObjectExpression(config)) {
        for (const prop of config.properties) {
          if (!t.isObjectProperty(prop)) continue;
          const section = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : '';
          if (section !== 'variants' || !t.isObjectExpression(prop.value)) continue;
          for (const axis of prop.value.properties) {
            if (!t.isObjectProperty(axis) || !t.isObjectExpression(axis.value)) continue;
            const axisName = t.isIdentifier(axis.key) ? axis.key.name : t.isStringLiteral(axis.key) ? axis.key.value : '';
            for (const val of axis.value.properties) {
              if (!t.isObjectProperty(val)) continue;
              const valName = t.isIdentifier(val.key) ? val.key.name : t.isStringLiteral(val.key) ? val.key.value : String((val.key as any).value);
              const refusals: Refusal[] = [];
              const candidates = readClasses(val.value as t.Node, refusals);
              sites.push({
                candidates,
                loc: locOf(val),
                kind: 'cva-variant',
                variantAxis: axisName,
                variantValue: valName,
                refusals,
              });
            }
          }
        }
      }
    },
  });

  return { sites, hasStyleX };
}
