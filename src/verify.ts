import { transformSync } from '@babel/core';
import stylexPluginMod from '@stylexjs/babel-plugin';

// Same CJS interop dance as tailwindcss: Node nests the export under .default.
const stylexPlugin: unknown =
  typeof stylexPluginMod === 'function' ? stylexPluginMod : (stylexPluginMod as { default?: unknown }).default;
import postcss from 'postcss';
import type { Resolved } from './reshape.ts';
import { printCreate, type SxNamespace } from './emit.ts';

export type CompiledRule = { className: string; css: string; priority: number };

export type Mismatch = {
  namespace: string;
  condition: string;
  property: string;
  tailwind: string | undefined;
  stylex: string | undefined;
};

export type VerifyResult =
  | { ok: true; rules: CompiledRule[] }
  | { ok: false; kind: 'compile-error'; message: string }
  | { ok: false; kind: 'mismatch'; mismatches: Mismatch[]; rules: CompiledRule[] };

// StyleX hashes class names from the filename, and Babel caches per filename. Reusing one
// virtual name across compiles made results depend on how many files had been processed
// before - a determinism bug that showed up as different totals under Node vs Bun.
let compileSeq = 0;

/** Compile a stylex.create source through the real StyleX Babel plugin. */
export function compileStyleX(source: string): { rules: CompiledRule[] } | { error: string } {
  const code = `import * as stylex from '@stylexjs/stylex';\n${source}\nexport { styles };\n`;
  try {
    const res = transformSync(code, {
      filename: `/tw2sx/virtual-${compileSeq++}.js`,
      babelrc: false,
      configFile: false,
      plugins: [
        [
          stylexPlugin,
          {
            dev: false,
            runtimeInjection: false,
            enableMinifiedKeys: false,
            // StyleX rewrites overlapping min-width queries into non-overlapping ranges
            // (`(min-width:40rem) and (max-width:63.99rem)`). That is semantics-preserving -
            // Tailwind reaches the same result through source order - but it obscures a
            // declaration-level diff, so compare against the authored queries.
            enableMediaQueryOrder: false,
            // Surface the silently-dropped shorthands instead of losing them.
            propertyValidationMode: 'throw',
            unstable_moduleResolution: { type: 'commonJS', rootDir: '/tw2sx' },
          },
        ],
      ],
    });
    const meta = (res?.metadata as any)?.stylex as [string, { ltr: string }, number][] | undefined;
    return {
      rules: (meta ?? []).map(([className, r, priority]) => ({ className, css: r.ltr, priority })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse StyleX's emitted atomic rules back into (condition, property) -> value. */
export function declsFromRules(rules: CompiledRule[]): Map<string, { path: string[]; props: Map<string, string> }> {
  const out = new Map<string, { path: string[]; props: Map<string, string> }>();
  for (const { css } of rules) {
    const root = postcss.parse(css);
    walk(root, []);
  }
  function walk(node: postcss.Container, path: string[]) {
    node.each((child) => {
      if (child.type === 'decl') {
        const k = path.join(' ');
        if (!out.has(k)) out.set(k, { path, props: new Map() });
        out.get(k)!.props.set(child.prop, child.value.trim());
      } else if (child.type === 'atrule') {
        walk(child as postcss.AtRule, [...path, `@${(child as postcss.AtRule).name} ${(child as postcss.AtRule).params}`]);
      } else if (child.type === 'rule') {
        // StyleX selectors look like `.xabc.xabc:hover` or `.xabc[data-state="open"]`.
        const sel = (child as postcss.Rule).selector;
        const suffix = sel.replace(/^(\.[A-Za-z0-9_-]+)+/, '').replace(/:not\(#\\?#\)/g, '');
        walk(child as postcss.Rule, suffix ? [...path, suffix] : path);
      }
    });
  }
  return out;
}

/**
 * Canonicalise one condition. The two systems spell the same thing differently:
 * Tailwind v4 emits CSS range syntax, StyleX emits min-/max-width.
 */
function normOne(s: string): string {
  let t = s.trim().replace(/\s+/g, ' ').replace(/'/g, '"');
  const media = t.match(/^@media \((.+)\)$/);
  if (media) {
    const q = media[1]
      .replace(/^width\s*>=\s*(.+)$/, 'min-width: $1')
      .replace(/^width\s*<=\s*(.+)$/, 'max-width: $1')
      .replace(/^width\s*>\s*(.+)$/, 'min-width: $1')
      .replace(/^width\s*<\s*(.+)$/, 'max-width: $1')
      .replace(/\s*:\s*/, ': ');
    t = `@media (${q})`;
  }
  return t;
}

/** Split a selector suffix into its atoms: `:active:not(*[x])` -> [':active', ':not(*[x])']. */
function selectorAtoms(s: string): string[] {
  const atoms: string[] = [];
  const re = /(::?[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) atoms.push(m[1]);
  return atoms.length ? atoms : s.trim() ? [s.trim()] : [];
}

/**
 * Normalise a condition path for comparison across the two systems.
 * Tailwind nests `&:active { &:not(x) }` where StyleX flattens to `:active:not(x)`,
 * so selector atoms are pooled and sorted independently of at-rules.
 */
export function normCondition(path: string[]): string {
  const atRules: string[] = [];
  const atoms: string[] = [];
  for (const seg of path.map(normOne).filter(Boolean)) {
    // v4 wraps every hover in a hover-capability query; StyleX does not.
    if (seg === '@media (hover: hover)') continue;
    if (seg.startsWith('@')) atRules.push(seg);
    else atoms.push(...selectorAtoms(seg));
  }
  return [...atRules.sort(), atoms.sort().join('')].filter(Boolean).join(' ');
}

/**
 * StyleX runs values through lightningcss, which minifies them. Undo the
 * minifications so a value difference means a real difference.
 */
const normValue = (v: string) =>
  v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    // leading zero dropped: 0.1 -> .1
    .replace(/(^|[\s,(/])0\.(\d)/g, '$1.$2')
    // ms collapsed to s: 150ms -> .15s
    .replace(/(^|[\s,(])(\d*\.?\d+)ms\b/g, (_, p, n) => `${p}${trimNum(Number(n) / 1000)}s`)
    // any zero length is just 0
    .replace(/(^|[\s,(])0(px|rem|em|%|vh|vw|s)\b/g, '$10')
    // slash spacing differs: `4/3` vs `4 / 3`, `rgb(x)/0.3` vs `rgb(x) / .3`
    .replace(/\s*\/\s*/g, '/')
    .replace(/;$/, '');

const trimNum = (n: number) => String(n).replace(/^0\./, '.');

const kebab = (p: string) => (p.startsWith('--') ? p : p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));

/**
 * ADR-0003: the correctness gate. Compare the declarations Tailwind produced against
 * the declarations the generated StyleX actually compiles to.
 */
export function verifyNamespace(name: string, resolved: Resolved, ns: SxNamespace): VerifyResult {
  const src = printCreate({ [name]: ns });
  const compiled = compileStyleX(src);
  if ('error' in compiled) return { ok: false, kind: 'compile-error', message: compiled.error };

  const actual = declsFromRules(compiled.rules);
  const mismatches: Mismatch[] = [];

  // Expected: what Tailwind said, keyed the same way.
  const expected = new Map<string, Map<string, string>>();
  for (const { path, props } of resolved.decls.values()) {
    const k = normCondition(path);
    if (!expected.has(k)) expected.set(k, new Map());
    for (const [prop, value] of props) expected.get(k)!.set(kebab(prop), value);
  }

  const actualNorm = new Map<string, Map<string, string>>();
  for (const { path, props } of actual.values()) {
    const k = normCondition(path);
    if (!actualNorm.has(k)) actualNorm.set(k, new Map());
    for (const [p, v] of props) actualNorm.get(k)!.set(p, v);
  }

  for (const [cond, props] of expected) {
    for (const [prop, want] of props) {
      const got = actualNorm.get(cond)?.get(prop);
      if (got === undefined || normValue(got) !== normValue(want))
        mismatches.push({ namespace: name, condition: cond || 'default', property: prop, tailwind: want, stylex: got });
    }
  }
  for (const [cond, props] of actualNorm) {
    for (const [prop, got] of props) {
      if (!expected.get(cond)?.has(prop))
        mismatches.push({ namespace: name, condition: cond || 'default', property: prop, tailwind: undefined, stylex: got });
    }
  }

  return mismatches.length
    ? { ok: false, kind: 'mismatch', mismatches, rules: compiled.rules }
    : { ok: true, rules: compiled.rules };
}
