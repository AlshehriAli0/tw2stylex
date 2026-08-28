#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDesignSystem } from './resolve.ts';
import { resolveElement, REASONS } from './reshape.ts';
import { toNamespace, printCreate } from './emit.ts';
import { verifyNamespace } from './verify.ts';
import { plan, collectFiles, findEntryCss } from './pipeline.ts';
import { applyFile, dirtyFiles } from './apply.ts';
import { loadDesignSystem as loadSys } from './resolve.ts';
import { renderAgent, fail, EXIT, type Report, type Finding } from './report.ts';

const HELP = `tw2sx - migrate Tailwind v4 to StyleX.

Converts a style site only when it can prove the CSS declarations come out identical to what
Tailwind produced. Everything else it REFUSES and reports, with a reason and a fix.

COMMANDS  (read-only unless marked)
  tw2sx explain "<classes>"     Print the StyleX object for a class string, and whether it verified.
  tw2sx plan <path>             Convert + verify a tree. Writes a JSON report.
  tw2sx refusals <report.json>  Re-read a report, filtered.
  tw2sx apply <path> --write    WRITES CODE. Rewrites only the sites that verified.

TYPICAL RUN
  tw2sx plan src/components        # mismatches must be 0; refusals are the work
  tw2sx refusals .tw2sx/plan-*.json --applicability machine-applicable
  ...fix those, then re-run plan until the refusal count stops dropping

OPTIONS
  --css <file>        Tailwind entry CSS. Auto-detected from the target when omitted.
  --json[=<fields>]   JSON output. Bare --json lists the field names you can ask for.
  --limit <n>         Refusals printed (default 20). Use 0 for the summary alone.
  --reason <r>        Keep one reason code.
  --applicability <a> Keep one of: machine-applicable has-placeholders maybe-incorrect unspecified
  --out <file>        Report path (default .tw2sx/plan-<hash>.json).
  --write             apply only: edit files. Omitted, apply is a dry run.
  --allow-dirty       apply only: write over a tree with uncommitted changes.

A refusal carries a REASON (why it was refused) and an APPLICABILITY (what to do about it):
  machine-applicable  one right answer, safe to batch
  has-placeholders    you must locate something the tool could not (an ancestor, a child)
  maybe-incorrect     a rewrite exists but shifts behaviour at the edges; read the code first
  unspecified         investigate; often not a Tailwind class at all

REASON CODES
  ${REASONS.join(', ')}

EXIT  0 nothing refused · 1 completed with refusals · 2 usage · 3 precondition · 10 internal
Positions are 1-based line:column.`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else (out._ as string[]).push(a);
  }
  return out;
}

const die = (e: ReturnType<typeof fail>, json: boolean) => {
  if (json) console.error(JSON.stringify(e, null, 2));
  else console.error(`tw2sx: ${e.message}\nhint: ${e.hint}\ncode: ${e.code}`);
  process.exit(e.exit_code);
};

const FINDING_FIELDS = ['file', 'line', 'column', 'reason', 'applicability', 'candidate', 'detail', 'hint', 'rendered'];

function project<T extends object>(obj: T, fields?: string[]) {
  if (!fields?.length) return obj;
  const o: Record<string, unknown> = {};
  for (const f of fields) if (f in obj) o[f] = (obj as Record<string, unknown>)[f];
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = (args._ as string[])[0];
  const jsonFlag = args.json;
  const isJson = jsonFlag !== undefined && jsonFlag !== false;
  const jsonFields = typeof jsonFlag === 'string' && jsonFlag ? jsonFlag.split(',') : undefined;
  const limit = Number(args.limit ?? 20);

  if (!cmd || args.help || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd ? EXIT.CLEAN : EXIT.USAGE);
  }

  // Bare --json with no value: print the field names (the `gh` pattern).
  if (isJson && jsonFlag === true && cmd === 'refusals') {
    console.log(FINDING_FIELDS.join('\n'));
    process.exit(EXIT.CLEAN);
  }

  if (cmd === 'explain') {
    const classes = (args._ as string[]).slice(1).flatMap((s) => s.split(/\s+/)).filter(Boolean);
    if (!classes.length)
      die(fail('E_NO_INPUT', EXIT.USAGE, 'No classes given.', 'tw2sx explain "flex items-center p-4"'), isJson);
    const css = (args.css as string) ?? findEntryCss(process.cwd());
    if (!css)
      die(
        fail('E_NO_ENTRY_CSS', EXIT.PRECONDITION, 'Could not find a Tailwind entry CSS.', 'Pass it explicitly: tw2sx explain <classes> --css src/index.css'),
        isJson,
      );
    const sys = await loadDesignSystem(css as string);
    const resolved = resolveElement(sys.ds, classes);
    const ns = toNamespace(resolved);
    const v = verifyNamespace('styles', resolved, ns);
    const findings = resolved.refusals.map((r) => ({
      reason: r.reason,
      candidate: r.candidate,
      detail: r.detail,
      hint: r.hint,
    }));
    if (isJson) {
      console.log(JSON.stringify({ ok: v.ok, entry: sys.entry, tailwind: sys.version, stylex: ns, source: printCreate({ styles: ns }), refusals: findings }, null, 2));
    } else {
      console.log(printCreate({ styles: ns }));
      if (findings.length) {
        console.log('');
        for (const f of findings) console.log(`refused ${f.reason}${f.candidate ? ` "${f.candidate}"` : ''}: ${f.detail}\n  help: ${f.hint}`);
      }
      console.log('');
      console.log(v.ok ? `verified: declarations match Tailwind (${v.rules.length} atomic rules)` : `NOT VERIFIED: ${v.kind}`);
    }
    process.exit(findings.length ? EXIT.REFUSALS : EXIT.CLEAN);
  }

  if (cmd === 'plan') {
    const target = (args._ as string[])[1];
    if (!target) die(fail('E_NO_INPUT', EXIT.USAGE, 'No path given.', 'tw2sx plan src/components/ui'), isJson);
    if (!fs.existsSync(target))
      die(fail('E_NO_SUCH_PATH', EXIT.USAGE, `Path not found: ${target}`, 'Check the path and try again.'), isJson);
    const css = (args.css as string) ?? findEntryCss(fs.statSync(target).isDirectory() ? target : path.dirname(target));
    if (!css)
      die(
        fail('E_NO_ENTRY_CSS', EXIT.PRECONDITION, 'Could not find a Tailwind entry CSS near the target.', `Pass it explicitly: tw2sx plan ${target} --css src/index.css`),
        isJson,
      );

    const files = collectFiles(target);
    const report = await plan(css as string, files);

    const dir = '.tw2sx';
    const hash = crypto.createHash('sha1').update(files.join('\n')).digest('hex').slice(0, 6);
    const out = (args.out as string) ?? path.join(dir, `plan-${hash}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));

    if (isJson) console.log(JSON.stringify(summarise(report, jsonFields), null, 2));
    else console.log(renderAgent(report, limit, out));

    process.exit(!report.ok ? EXIT.INTERNAL : report.summary.refused ? EXIT.REFUSALS : EXIT.CLEAN);
  }

  if (cmd === 'apply') {
    const target = (args._ as string[])[1];
    if (!target || !fs.existsSync(target))
      die(fail('E_NO_SUCH_PATH', EXIT.USAGE, `Path not found: ${target}`, 'tw2sx apply src/components/ui'), isJson);
    const write = args.write === true;
    if (write && !args['allow-dirty']) {
      const dirty = dirtyFiles(path.resolve(fs.statSync(target).isDirectory() ? target : path.dirname(target)));
      if (dirty && dirty.length)
        die(
          fail(
            'E_DIRTY_TREE',
            EXIT.PRECONDITION,
            `Refusing to write: ${dirty.length} uncommitted change(s) under ${target}.\n  ${dirty.slice(0, 5).join('\n  ')}`,
            'Commit or stash first, or re-run with --allow-dirty (your edits will be interleaved and hard to revert).',
          ),
          isJson,
        );
    }
    const css = (args.css as string) ?? findEntryCss(fs.statSync(target).isDirectory() ? target : path.dirname(target));
    if (!css)
      die(fail('E_NO_ENTRY_CSS', EXIT.PRECONDITION, 'Could not find a Tailwind entry CSS.', `tw2sx apply ${target} --css src/index.css`), isJson);
    const sys = await loadSys(css as string);
    const results = collectFiles(target).map((f) => applyFile(sys, f, write));
    const touched = results.filter((r) => r.rewritten > 0);
    const sites = touched.reduce((a, r) => a + r.rewritten, 0);
    const skipped = results.reduce((a, r) => a + r.skipped, 0);
    if (isJson) {
      console.log(JSON.stringify({ ok: true, write, files: touched.map((r) => ({ ...r, diff: undefined })), summary: { files: touched.length, rewritten: sites, skipped } }, null, 2));
    } else {
      console.log(`${touched.length} files · ${sites} sites rewritten · ${skipped} left for you${write ? '' : '  (DRY RUN - pass --write to edit)'}`);
      for (const r of touched.slice(0, limit)) console.log(`  ${r.file}: ${r.rewritten} rewritten, ${r.skipped} skipped`);
      if (touched.length > limit) console.log(`\nShowing ${limit} of ${touched.length} files.`);
      if (!write && touched.length) console.log(`\nNext: tw2sx apply ${target} --write`);
    }
    process.exit(skipped ? EXIT.REFUSALS : EXIT.CLEAN);
  }

  if (cmd === 'refusals') {
    const file = (args._ as string[])[1];
    if (!file || !fs.existsSync(file))
      die(fail('E_NO_REPORT', EXIT.USAGE, `Report not found: ${file}`, 'Run tw2sx plan <path> first.'), isJson);
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as Report;
    let findings: Finding[] = report.files.flatMap((f) => f.findings);
    if (args.reason) findings = findings.filter((f) => f.reason === args.reason);
    if (args.applicability) findings = findings.filter((f) => f.applicability === args.applicability);
    const shown = findings.slice(0, limit);
    if (isJson) console.log(JSON.stringify(shown.map((f) => project(f, jsonFields)), null, 2));
    else {
      for (const f of shown) console.log(f.rendered);
      if (findings.length > shown.length) console.log(`\nShowing ${shown.length} of ${findings.length}.`);
    }
    process.exit(findings.length ? EXIT.REFUSALS : EXIT.CLEAN);
  }

  die(fail('E_UNKNOWN_COMMAND', EXIT.USAGE, `Unknown command: ${cmd}`, 'Run tw2sx help.'), isJson);
}

function summarise(report: Report, fields?: string[]) {
  return {
    ok: report.ok,
    tool: report.tool,
    tailwind: report.tailwind,
    entry: report.entry,
    summary: report.summary,
    files: report.files.map((f) => ({
      file: f.file,
      verdict: f.verdict,
      sites: f.sites,
      converted: f.converted,
      refused: f.refused,
      findings: f.findings.map((x) => project(x, fields)),
    })),
  };
}

main().catch((e) => {
  console.error(
    JSON.stringify(fail('E_INTERNAL', EXIT.INTERNAL, e instanceof Error ? e.message : String(e), 'This is a tw2sx bug. Re-run with --json and file the output.'), null, 2),
  );
  process.exit(EXIT.INTERNAL);
});
