import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads the *project's own* Tailwind design system, so `@theme`, `@utility`,
 * `@custom-variant`, `@plugin` and `@config` are all in scope. Prior converters
 * bundle a stock theme.css and silently resolve project tokens to stock values.
 */
export type DesignSystem = {
  candidatesToCss(classes: string[]): (string | null)[];
  candidatesToAst(classes: string[]): unknown[][];
  getClassOrder(classes: string[]): [string, bigint | null][];
  parseCandidate(candidate: string): readonly unknown[];
  resolveThemeValue(path: string, forceInline?: boolean): string | undefined;
};

export type LoadedSystem = { ds: DesignSystem; entry: string; base: string; version: string };

const splitPkg = (id: string) => {
  const parts = id.split('/');
  const n = id.startsWith('@') ? 2 : 1;
  return { pkg: parts.slice(0, n).join('/'), rest: parts.slice(n).join('/') };
};

/** Pick a CSS file out of an exports entry, honouring the `style` condition. */
function cssFromExports(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.endsWith('.css') ? entry : undefined;
  if (entry && typeof entry === 'object') {
    const e = entry as Record<string, unknown>;
    for (const key of ['style', 'default', 'import', 'require']) {
      const hit = cssFromExports(e[key]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function makeResolver(base: string) {
  const require = createRequire(path.join(base, '__tw2sx__.js'));

  /**
   * Locate a package's directory. `require.resolve('pkg/package.json')` fails on packages
   * whose `exports` map does not list it (Node enforces this; Bun does not), so walk
   * node_modules directly.
   */
  function pkgRoot(pkg: string): string {
    for (const dir of require.resolve.paths(pkg) ?? []) {
      const candidate = path.join(dir, pkg);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    // Fall back to whatever the main entry resolves to and walk up to its package.json.
    let cur = path.dirname(require.resolve(pkg));
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
      const next = path.dirname(cur);
      if (next === cur) break;
      cur = next;
    }
    throw new Error(`cannot locate package "${pkg}" from ${base}`);
  }

  /** Resolve a stylesheet specifier the way a CSS bundler would. */
  function resolveCss(id: string, from: string): string {
    if (id.startsWith('.') || path.isAbsolute(id)) {
      let f = path.resolve(from, id);
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.css');
      if (!fs.existsSync(f) && fs.existsSync(f + '.css')) f += '.css';
      return f;
    }
    const { pkg, rest } = splitPkg(id);
    const root = pkgRoot(pkg);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    // A subpath that is already a file (e.g. "pkg/style.css").
    if (rest) {
      const direct = path.join(root, rest);
      if (fs.existsSync(direct)) return direct;
      const viaExports = cssFromExports(meta.exports?.[`./${rest}`]);
      if (viaExports) return path.join(root, viaExports);
      if (fs.existsSync(direct + '.css')) return direct + '.css';
      return direct;
    }
    // Package root: exports["."] with a `style` condition, then style/main, then index.css.
    const candidates = [
      cssFromExports(meta.exports?.['.']) ?? cssFromExports(meta.exports),
      typeof meta.style === 'string' ? meta.style : undefined,
      typeof meta.main === 'string' && meta.main.endsWith('.css') ? meta.main : undefined,
      'index.css',
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      const f = path.join(root, c);
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`no stylesheet found for "${id}" (looked in ${root})`);
  }

  return { require, resolveCss, pkgRoot };
}

export async function loadDesignSystem(entryCssPath: string): Promise<LoadedSystem> {
  const entry = path.resolve(entryCssPath);
  if (!fs.existsSync(entry)) throw new Error(`entry CSS not found: ${entry}`);
  const base = path.dirname(entry);
  const { require, resolveCss, pkgRoot } = makeResolver(base);

  const twPath = require.resolve('tailwindcss');
  // tailwindcss ships CJS; Node's ESM interop puts the exports under .default, Bun does not.
  const twMod = await import(twPath);
  const tw = typeof twMod.__unstable__loadDesignSystem === 'function' ? twMod : twMod.default;
  if (typeof tw?.__unstable__loadDesignSystem !== 'function')
    throw new Error(
      `tailwindcss at ${twPath} does not export __unstable__loadDesignSystem. tw2sx needs Tailwind v4.`,
    );
  const version = JSON.parse(fs.readFileSync(path.join(pkgRoot('tailwindcss'), 'package.json'), 'utf8')).version;

  async function loadStylesheet(id: string, from: string) {
    const file = resolveCss(id, from);
    return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
  }
  async function loadModule(id: string, from: string, _kind: 'plugin' | 'config') {
    const file = id.startsWith('.') || path.isAbsolute(id) ? path.resolve(from, id) : require.resolve(id);
    const mod = await import(file);
    return { path: file, base: path.dirname(file), module: mod.default ?? mod };
  }

  const ds = (await tw.__unstable__loadDesignSystem(fs.readFileSync(entry, 'utf8'), {
    base, loadStylesheet, loadModule,
  })) as DesignSystem;

  return { ds, entry, base, version };
}
