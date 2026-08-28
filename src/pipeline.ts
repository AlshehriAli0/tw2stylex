import fs from 'node:fs';
import path from 'node:path';
import { loadDesignSystem, type LoadedSystem } from './resolve.ts';
import { scanFile, type Site } from './extract.ts';
import { resolveElement } from './reshape.ts';
import { toNamespace, printCreate, type SxNamespace } from './emit.ts';
import { verifyNamespace } from './verify.ts';
import { toFinding, type FileResult, type Report } from './report.ts';

/** Name a namespace after where it came from, never `$1`/`$2`. */
export function namespaceName(site: Site, index: number, used: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  let base: string;
  if (site.kind === 'cva-base') base = 'base';
  else if (site.kind === 'cva-variant') base = clean(`${site.variantAxis}-${site.variantValue}`);
  else base = `el${index + 1}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

export function processFile(sys: LoadedSystem, file: string): FileResult {
  const code = fs.readFileSync(file, 'utf8');
  const { sites } = scanFile(code, file);
  const findings: FileResult['findings'] = [];
  const mismatches: FileResult['mismatches'] = [];
  const namespaces: Record<string, SxNamespace> = {};
  const used = new Set<string>();
  let converted = 0;

  sites.forEach((site, i) => {
    for (const r of site.refusals) findings.push(toFinding(file, site.loc.line, site.loc.column, r));
    if (!site.candidates.length) return;

    const resolved = resolveElement(sys.ds, site.candidates);
    for (const r of resolved.refusals) findings.push(toFinding(file, site.loc.line, site.loc.column, r));

    if (!resolved.decls.size) return;
    const name = namespaceName(site, i, used);
    const ns = toNamespace(resolved);
    const v = verifyNamespace(name, resolved, ns);
    if (v.ok) {
      namespaces[name] = ns;
      converted++;
    } else if (v.kind === 'compile-error') {
      findings.push(
        toFinding(file, site.loc.line, site.loc.column, {
          reason: 'banned-shorthand',
          detail: `Generated StyleX does not compile: ${v.message.split('\n').pop()?.trim()}`,
          hint: 'This is a tw2sx bug or an unsupported utility; convert this site by hand.',
        }),
      );
    } else {
      mismatches.push(...v.mismatches);
      findings.push(
        toFinding(file, site.loc.line, site.loc.column, {
          reason: 'condition-erasure',
          detail: `Generated StyleX declarations differ from Tailwind's in ${v.mismatches.length} place(s).`,
          hint: 'See the mismatches array in the JSON report; convert this site by hand.',
        }),
      );
    }
  });

  const total = sites.length;
  const refused = total - converted;
  return {
    file,
    verdict: total === 0 ? 'unchanged' : refused === 0 ? 'converted' : converted === 0 ? 'refused' : 'partial',
    sites: total,
    converted,
    refused,
    source: Object.keys(namespaces).length ? printCreate(namespaces) : undefined,
    findings,
    mismatches,
  };
}

export async function plan(entryCss: string, files: string[]): Promise<Report> {
  const sys = await loadDesignSystem(entryCss);
  const results = files.map((f) => processFile(sys, f));
  const byReason: Record<string, number> = {};
  const byApplicability: Record<string, number> = {};
  for (const r of results)
    for (const f of r.findings) {
      byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
      byApplicability[f.applicability] = (byApplicability[f.applicability] ?? 0) + 1;
    }
  const sum = (k: 'sites' | 'converted' | 'refused') => results.reduce((a, r) => a + r[k], 0);
  return {
    ok: results.every((r) => r.mismatches.length === 0),
    tool: 'tw2sx',
    tailwind: sys.version,
    entry: sys.entry,
    summary: {
      files: results.length,
      sites: sum('sites'),
      converted: sum('converted'),
      refused: sum('refused'),
      byReason,
      byApplicability,
    },
    files: results,
  };
}

/** Find the project's Tailwind entry CSS by looking for an @import "tailwindcss". */
export function findEntryCss(from: string): string | undefined {
  const roots = [from, ...ancestors(from)];
  for (const dir of roots) {
    for (const rel of ['src/index.css', 'src/app.css', 'src/styles/globals.css', 'app/globals.css', 'styles/globals.css', 'index.css']) {
      const f = path.join(dir, rel);
      if (fs.existsSync(f) && /@import\s+["']tailwindcss/.test(fs.readFileSync(f, 'utf8'))) return f;
    }
  }
  return undefined;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    const next = path.dirname(cur);
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

export function collectFiles(target: string): string[] {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(target, e.name);
    if (e.isDirectory()) out.push(...collectFiles(p));
    else if (/\.(tsx|jsx|ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
