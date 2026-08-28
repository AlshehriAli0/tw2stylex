import postcss, { type Rule, type AtRule, type Declaration } from 'postcss';
import type { DesignSystem } from './resolve.ts';

/** Why a Site or Candidate could not be converted. Closed enum: the skill has one section per code. */
export const REASONS = [
  'unknown-candidate', // Tailwind itself does not recognise the class
  'marker-class', // `group`/`peer`/`group//name` - becomes a StyleX Marker
  'descendant-selector', // [&_svg]:, [&>*]: - StyleX hard-errors on these
  'ancestor-state', // dark:, in-* - depends on an ancestor matching
  'sibling-variant', // group-*/peer-* - needs a Marker on another element
  'child-styling-utility', // space-x-*, divide-* - style children, not self
  'banned-shorthand', // background/border/animation - StyleX drops these silently
  'unresolved-tw-var', // a --tw-* slot with no value and no @property initial-value
  'unsupported-at-rule', // @starting-style and friends
  'dynamic-expression', // className built at runtime
  'cva-call',
  'contract-change',
  'condition-erasure',
  'conflicting-props', // element also carries a style/className attr alongside the spread
] as const;
export type Reason = (typeof REASONS)[number];

/**
 * What the agent should DO about a refusal - orthogonal to why it happened.
 * Mirrors rustc's suggestion_applicability.
 */
export type Applicability = 'machine-applicable' | 'maybe-incorrect' | 'has-placeholders' | 'unspecified';

/** Default action-class per reason. A Refusal may override it. */
export const APPLICABILITY: Record<Reason, Applicability> = {
  'unknown-candidate': 'unspecified',
  'marker-class': 'machine-applicable',
  'descendant-selector': 'has-placeholders',
  'ancestor-state': 'has-placeholders',
  'sibling-variant': 'has-placeholders',
  'child-styling-utility': 'maybe-incorrect',
  'banned-shorthand': 'machine-applicable',
  'unresolved-tw-var': 'maybe-incorrect',
  'unsupported-at-rule': 'has-placeholders',
  'dynamic-expression': 'maybe-incorrect',
  'cva-call': 'machine-applicable',
  'contract-change': 'maybe-incorrect',
  'condition-erasure': 'maybe-incorrect',
  'conflicting-props': 'maybe-incorrect',
};

export type Refusal = {
  reason: Reason;
  candidate?: string;
  detail: string;
  hint: string;
  applicability?: Applicability;
};

/** An ordered condition path, outermost first: ['@media (hover: hover)', ':hover'] */
export type CondPath = string[];
const KEY = (p: CondPath) => p.join(' ');

export type Resolved = {
  /** condition key -> { path, property -> value }, filled in application order (later wins). */
  decls: Map<string, { path: CondPath; props: Map<string, string> }>;
  refusals: Refusal[];
};

const BANNED_SHORTHANDS = new Set([
  'all',
  'animation',
  'background',
  'border',
  'border-inline',
  'border-block',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-inline-start',
  'border-inline-end',
]);

/** The longhand set to write in place of each banned shorthand. */
const LONGHANDS_FOR: Record<string, string> = {
  background: 'Write backgroundColor (or backgroundImage) instead.',
  animation:
    'Define the keyframes with stylex.keyframes(), then set animationName, animationDuration, animationTimingFunction and animationIterationCount.',
  border: 'Write borderWidth, borderStyle and borderColor.',
  'border-top': 'Write borderTopWidth, borderTopStyle and borderTopColor.',
  'border-right': 'Write borderRightWidth, borderRightStyle and borderRightColor.',
  'border-bottom': 'Write borderBottomWidth, borderBottomStyle and borderBottomColor.',
  'border-left': 'Write borderLeftWidth, borderLeftStyle and borderLeftColor.',
  'border-inline': 'Write borderInlineWidth, borderInlineStyle and borderInlineColor.',
  'border-block': 'Write borderBlockWidth, borderBlockStyle and borderBlockColor.',
  'border-inline-start': 'Write borderInlineStartWidth, borderInlineStartStyle and borderInlineStartColor.',
  'border-inline-end': 'Write borderInlineEndWidth, borderInlineEndStyle and borderInlineEndColor.',
  all: 'Set each property this utility touches explicitly.',
};

/** Values Tailwind uses as "this slot is empty"; dropping them keeps output readable. */
const NOOP_VALUES = new Set(['0 0 #0000', 'none', '']);

const camel = (p: string) => (p.startsWith('--') ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
const esc = (s: string) => s.replace(/\\(.)/g, '$1');

/**
 * Does this selector target only the element carrying the class?
 * Handles both flat (`.foo:hover`) and v4's nested (`&:hover`) forms.
 * Returns the suffix, or null if the selector reaches another element.
 */
/** Split a selector list on top-level commas only: escaped (`\,`) and bracketed ones stay put. */
function splitSelectorList(sel: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '\\') {
      cur += ch + (sel[++i] ?? '');
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function selfSelector(selector: string, className: string): string | null {
  const cls = '.' + className;
  const suffixes = new Set<string>();
  for (const part of splitSelectorList(selector).map((s) => s.trim())) {
    const u = esc(part);
    let rest: string;
    if (u.startsWith('&')) rest = u.slice(1);
    else if (u.startsWith(cls)) rest = u.slice(cls.length);
    else return null;
    // Any combinator anywhere - including nested inside :is()/:where() - means the
    // selector describes a relationship to another element, which StyleX cannot express
    // as a self-condition. Attribute values are masked first so `[x="a b"]` stays self.
    const masked = rest.replace(/"[^"]*"|'[^']*'/g, '""');
    if (/[\s>+~]/.test(masked)) return null;
    suffixes.add(rest);
  }
  return suffixes.size === 1 ? [...suffixes][0] : null;
}

/** Substitute `var(--tw-x, fallback)` using values the element's own classes set. */
function expandTwVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 10 || !value.includes('var(--tw-')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(--tw-', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // Find the matching close paren.
    let depthP = 0;
    let j = at + 3; // at 'var' + '('
    for (; j < value.length; j++) {
      if (value[j] === '(') depthP++;
      else if (value[j] === ')') {
        depthP--;
        if (depthP === 0) break;
      }
    }
    const inner = value.slice(at + 4, j); // between 'var(' and ')'
    const comma = splitTopLevel(inner);
    const name = comma[0].trim();
    const fallback = comma.slice(1).join(',').trim();
    const resolved = vars.has(name) ? vars.get(name)! : fallback;
    out += expandTwVars(resolved, vars, depth + 1);
    i = j + 1;
  }
  return out;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Drop Tailwind's empty-slot placeholders from a composed list value. */
function tidyList(value: string): string {
  const parts = splitTopLevel(value)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !NOOP_VALUES.has(p));
  return parts.length ? parts.join(', ') : 'none';
}

/** Resolve one element's full candidate set into an ordered declaration map. */
export function resolveElement(ds: DesignSystem, candidates: string[]): Resolved {
  const refusals: Refusal[] = [];
  const seen = new Set<string>();
  const decls: Resolved['decls'] = new Map();
  const refuse = (r: Refusal) => {
    const k = `${r.reason}|${r.candidate}|${r.detail}`;
    if (seen.has(k)) return;
    seen.add(k);
    refusals.push(r);
  };

  // Tailwind's own conflict order: ascending index, last emitted wins.
  const order = ds.getClassOrder(candidates);
  const rank = new Map<string, bigint>();
  for (const [candidate, n] of order) {
    if (n === null) {
      const marker = /^(group|peer)(\/[\w-]+)?$/.exec(candidate);
      if (marker) {
        const named = marker[2]?.slice(1);
        refuse({
          reason: 'marker-class',
          candidate,
          detail: `"${candidate}" marks this element so descendants or siblings can react to its state.`,
          hint: named
            ? `Export \`const ${named}Marker = stylex.defineMarker();\` from a .stylex.ts file and spread stylex.props(${named}Marker) here; reacting elements use stylex.when.ancestor(':hover', ${named}Marker).`
            : `Spread stylex.props(stylex.defaultMarker()) on this element; reacting elements use stylex.when.ancestor(':hover').`,
        });
        continue;
      }
      refuse({
        reason: 'unknown-candidate',
        candidate,
        detail: `Tailwind does not recognise "${candidate}" in this project's design system.`,
        hint: 'Check for a typo, a missing @plugin, or a class defined in plain CSS (which needs no migration).',
      });
      continue;
    }
    rank.set(candidate, n);
  }
  const known = [...rank.keys()].sort((a, b) => (rank.get(a)! < rank.get(b)! ? -1 : 1));
  const cssList = ds.candidatesToCss(known);
  const roots = known.map((c, i) => (cssList[i] == null ? null : postcss.parse(cssList[i]!)));

  // Pass 1: gather --tw-* values. @property initial-values are the defaults;
  // declarations from the element's own classes override them.
  const twVars = new Map<string, string>();
  for (const root of roots) {
    if (!root) continue;
    // An @property with no initial-value is genuinely unset: leave it out so that
    // `var(--tw-shadow-color, rgb(0 0 0 / .1))` keeps its fallback instead of going empty.
    root.walkAtRules('property', (at) => {
      const name = at.params.trim();
      at.walkDecls('initial-value', (d) => {
        twVars.set(name, d.value);
      });
    });
  }
  for (const root of roots) {
    if (!root) continue;
    root.walkDecls((d) => {
      if (d.prop.startsWith('--tw-')) twVars.set(d.prop, d.value);
    });
  }

  function put(path: CondPath, prop: string, rawValue: string, candidate: string) {
    if (prop.startsWith('--tw-')) return; // internal plumbing, never emitted
    if (BANNED_SHORTHANDS.has(prop)) {
      refuse({
        reason: 'banned-shorthand',
        candidate,
        detail: `"${candidate}" emits the "${prop}" shorthand, which StyleX drops silently.`,
        hint: LONGHANDS_FOR[prop] ?? `Write the longhands of "${prop}" instead.`,
      });
      return;
    }
    let value = expandTwVars(rawValue, twVars).trim();
    if (value.includes('var(--tw-')) {
      refuse({
        reason: 'unresolved-tw-var',
        candidate,
        detail: `"${candidate}" leaves an unresolved Tailwind slot in "${prop}: ${value}".`,
        hint: 'Set this property to a literal value, or keep the utility in plain CSS.',
      });
      return;
    }
    if (value.includes(',') && /shadow|filter|transition|transform/.test(prop)) value = tidyList(value);
    const k = KEY(path);
    if (!decls.has(k)) decls.set(k, { path, props: new Map() });
    decls.get(k)!.props.set(camel(prop), value);
  }

  function walk(node: postcss.Container, path: CondPath, candidate: string) {
    node.each((child) => {
      if (child.type === 'decl') {
        const d = child as Declaration;
        put(path, d.prop, d.value, candidate);
      } else if (child.type === 'atrule') {
        const at = child as AtRule;
        if (at.name === 'property') return;
        if (!['media', 'supports', 'container'].includes(at.name)) {
          refuse({
            reason: 'unsupported-at-rule',
            candidate,
            detail: `"${candidate}" emits @${at.name}, which has no StyleX condition form.`,
            hint: 'Move this rule to a plain CSS file.',
          });
          return;
        }
        walk(at, [...path, `@${at.name} ${at.params}`], candidate);
      } else if (child.type === 'rule') {
        const rule = child as Rule;
        const suffix = selfSelector(rule.selector, candidate);
        if (suffix === null) {
          refuse(classifySelector(rule.selector, candidate));
          return;
        }
        walk(rule, suffix ? [...path, suffix] : path, candidate);
      }
    });
  }

  known.forEach((candidate, i) => {
    const root = roots[i];
    if (root) walk(root, [], candidate);
  });

  return { decls, refusals };
}

function classifySelector(selector: string, candidate: string): Refusal {
  const s = esc(selector);
  if (/>\s*:not\(:last-child\)/.test(s) || /^(space|divide)-/.test(candidate))
    return {
      reason: 'child-styling-utility',
      candidate,
      detail: `"${candidate}" styles this element's children via "${s}".`,
      hint: 'Use gap on the parent, or move the style onto the child component.',
    };
  if (/\.group|\.peer/.test(s))
    return {
      reason: 'sibling-variant',
      candidate,
      detail: `"${candidate}" depends on a marked ancestor or sibling ("${s}").`,
      hint: 'Use stylex.when.ancestor()/siblingBefore() plus stylex.defaultMarker() on that element.',
    };
  // `&:is(.dark *)` and friends: the element matches only under some ancestor.
  if (/^&?:is\(|^&?:where\(/.test(s.trim()) || /\*/.test(s))
    return {
      reason: 'ancestor-state',
      candidate,
      detail: `"${candidate}" applies only under an ancestor ("${s}").`,
      hint: 'For dark mode use stylex.createTheme(); otherwise stylex.when.ancestor() with a marker.',
    };
  return {
    reason: 'descendant-selector',
    candidate,
    detail: `"${candidate}" targets a descendant ("${s}"). StyleX hard-errors on descendant selectors.`,
    hint: 'Style the child component directly instead.',
  };
}
