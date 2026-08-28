import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { applyFile, dirtyFiles, type ApplyFileResult } from "./apply.ts";
import { flagBare, flagNumber, flagPresent, flagString, positionalAt, type Args } from "./args.ts";
import { printCreate, toNamespace } from "./emit.ts";
import { isRecord } from "./interop.ts";
import { collectFiles, findEntryCss, plan } from "./pipeline.ts";
import {
  EXIT,
  fail,
  renderAgent,
  type ErrorEnvelope,
  type Finding,
  type Report,
} from "./report.ts";
import { resolveElement } from "./reshape.ts";
import { loadDesignSystem } from "./resolve.ts";
import { verifyNamespace } from "./verify.ts";

/** Every command returns an exit code or an error envelope; nothing calls process.exit itself. */
export type CommandResult = { exit: number } | ErrorEnvelope;

/**
 * `code` is the discriminator, not `ok` - a Report carries an `ok` field too, so testing
 * that would classify a perfectly good report as a failure.
 */
const isError = (r: object): r is ErrorEnvelope => "code" in r && typeof r.code === "string";

export const FINDING_FIELDS = [
  "file",
  "line",
  "column",
  "reason",
  "applicability",
  "candidate",
  "detail",
  "hint",
  "rendered",
];

type Output = { json: boolean; fields: string[] | undefined; limit: number };

export const readOutput = (args: Args): Output => {
  const raw = args.flags.get("json");
  return {
    json: raw !== undefined,
    fields: typeof raw === "string" && raw ? raw.split(",") : undefined,
    limit: flagNumber(args, "limit", 20),
  };
};

const emit = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

const project = (finding: Finding, fields: string[] | undefined): Record<string, unknown> => {
  if (!fields?.length) return { ...finding };
  const out: Record<string, unknown> = {};
  const bag: Record<string, unknown> = { ...finding };
  for (const field of fields) if (field in bag) out[field] = bag[field];
  return out;
};

/** The directory a target path lives in, for entry-CSS discovery. */
const containingDir = (target: string): string =>
  fs.statSync(target).isDirectory() ? target : path.dirname(target);

const entryCssFor = (args: Args, from: string, retry: string): string | ErrorEnvelope => {
  const explicit = flagString(args, "css");
  if (explicit !== undefined) return explicit;
  const found = findEntryCss(from);
  if (found !== undefined) return found;
  return fail(
    "E_NO_ENTRY_CSS",
    EXIT.PRECONDITION,
    "Could not find a Tailwind entry CSS.",
    `Pass it explicitly: ${retry} --css src/index.css`,
  );
};

const requireExistingPath = (target: string | undefined, usage: string): string | ErrorEnvelope => {
  if (target === undefined) return fail("E_NO_INPUT", EXIT.USAGE, "No path given.", usage);
  if (!fs.existsSync(target))
    return fail("E_NO_SUCH_PATH", EXIT.USAGE, `Path not found: ${target}`, usage);
  return target;
};

export const explainCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const classes = args.positional
    .slice(1)
    .flatMap(s => s.split(/\s+/))
    .filter(Boolean);
  if (classes.length === 0)
    return fail(
      "E_NO_INPUT",
      EXIT.USAGE,
      "No classes given.",
      'tw2sx explain "flex items-center p-4"',
    );

  const css = entryCssFor(args, process.cwd(), "tw2sx explain <classes>");
  if (typeof css !== "string") return css;

  const sys = await loadDesignSystem(css);
  const resolved = resolveElement(sys.ds, classes);
  const ns = toNamespace(resolved);
  const verdict = verifyNamespace("styles", resolved, ns);
  const source = printCreate({ styles: ns });

  if (out.json) {
    emit({
      ok: verdict.ok,
      entry: sys.entry,
      tailwind: sys.version,
      stylex: ns,
      source,
      refusals: resolved.refusals,
    });
  } else {
    console.log(source);
    if (resolved.refusals.length > 0) {
      console.log("");
      for (const r of resolved.refusals) {
        const named = r.candidate === undefined ? "" : ` "${r.candidate}"`;
        console.log(`refused ${r.reason}${named}: ${r.detail}\n  help: ${r.hint}`);
      }
    }
    console.log("");
    console.log(
      verdict.ok
        ? `verified: declarations match Tailwind (${verdict.rules.length} atomic rules)`
        : `NOT VERIFIED: ${verdict.kind}`,
    );
  }

  return { exit: resolved.refusals.length > 0 ? EXIT.REFUSALS : EXIT.CLEAN };
};

const summarise = (report: Report, fields: string[] | undefined): unknown => ({
  ok: report.ok,
  tool: report.tool,
  tailwind: report.tailwind,
  entry: report.entry,
  summary: report.summary,
  files: report.files.map(f => ({
    file: f.file,
    verdict: f.verdict,
    sites: f.sites,
    converted: f.converted,
    refused: f.refused,
    findings: f.findings.map(x => project(x, fields)),
  })),
});

const planExit = (report: Report): number => {
  if (!report.ok) return EXIT.INTERNAL;
  return report.summary.refused > 0 ? EXIT.REFUSALS : EXIT.CLEAN;
};

export const planCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const target = requireExistingPath(positionalAt(args, 1), "tw2sx plan src/components/ui");
  if (typeof target !== "string") return target;

  const css = entryCssFor(args, containingDir(target), `tw2sx plan ${target}`);
  if (typeof css !== "string") return css;

  const files = collectFiles(target);
  const report = await plan(css, files);

  const hash = crypto.createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 6);
  const reportPath = flagString(args, "out") ?? path.join(".tw2sx", `plan-${hash}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (out.json) emit(summarise(report, out.fields));
  else console.log(renderAgent(report, out.limit, reportPath));

  return { exit: planExit(report) };
};

const dirtyGuard = (target: string): ErrorEnvelope | undefined => {
  const dirty = dirtyFiles(path.resolve(containingDir(target)));
  if (!dirty || dirty.length === 0) return undefined;
  return fail(
    "E_DIRTY_TREE",
    EXIT.PRECONDITION,
    `Refusing to write: ${dirty.length} uncommitted change(s) under ${target}.\n  ${dirty.slice(0, 5).join("\n  ")}`,
    "Commit or stash first, or re-run with --allow-dirty (your edits will be interleaved and hard to revert).",
  );
};

const applyJson = (
  touched: ApplyFileResult[],
  write: boolean,
  rewritten: number,
  skipped: number,
): unknown => ({
  ok: true,
  write,
  files: touched.map(r => ({ ...r, diff: undefined })),
  summary: { files: touched.length, rewritten, skipped },
});

type ApplyPrint = {
  touched: ApplyFileResult[];
  write: boolean;
  rewritten: number;
  skipped: number;
  target: string;
  limit: number;
};

const printApply = ({ touched, write, rewritten, skipped, target, limit }: ApplyPrint): void => {
  const mode = write ? "" : "  (DRY RUN - pass --write to edit)";
  console.log(
    `${touched.length} files · ${rewritten} sites rewritten · ${skipped} left for you${mode}`,
  );
  for (const r of touched.slice(0, limit))
    console.log(`  ${r.file}: ${r.rewritten} rewritten, ${r.skipped} skipped`);
  if (touched.length > limit) console.log(`\nShowing ${limit} of ${touched.length} files.`);
  if (!write && touched.length > 0) console.log(`\nNext: tw2sx apply ${target} --write`);
};

export const applyCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const target = requireExistingPath(positionalAt(args, 1), "tw2sx apply src/components/ui");
  if (typeof target !== "string") return target;

  const write = flagBare(args, "write");
  if (write && !flagPresent(args, "allow-dirty")) {
    const blocked = dirtyGuard(target);
    if (blocked) return blocked;
  }

  const css = entryCssFor(args, containingDir(target), `tw2sx apply ${target}`);
  if (typeof css !== "string") return css;

  const sys = await loadDesignSystem(css);
  const results = collectFiles(target).map(f => applyFile(sys, f, write));
  const touched = results.filter(r => r.rewritten > 0);
  const rewritten = touched.reduce((a, r) => a + r.rewritten, 0);
  const skipped = results.reduce((a, r) => a + r.skipped, 0);

  if (out.json) emit(applyJson(touched, write, rewritten, skipped));
  else printApply({ touched, write, rewritten, skipped, target, limit: out.limit });

  return { exit: skipped > 0 ? EXIT.REFUSALS : EXIT.CLEAN };
};

const isReport = (v: unknown): v is Report => isRecord(v) && Array.isArray(v.files);

const readReport = (file: string): Report | undefined => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return isReport(parsed) ? parsed : undefined;
};

const filterFindings = (report: Report, args: Args): Finding[] => {
  const reason = flagString(args, "reason");
  const applicability = flagString(args, "applicability");
  return report.files
    .flatMap(f => f.findings)
    .filter(f => reason === undefined || f.reason === reason)
    .filter(f => applicability === undefined || f.applicability === applicability);
};

/** Load the report named by the first positional, or say precisely why we could not. */
const openReport = (args: Args): Report | ErrorEnvelope => {
  const file = positionalAt(args, 1);
  if (file === undefined || !fs.existsSync(file))
    return fail(
      "E_NO_REPORT",
      EXIT.USAGE,
      `Report not found: ${file ?? "(none given)"}`,
      "Run tw2sx plan <path> first.",
    );

  const report = readReport(file);
  if (!report)
    return fail(
      "E_BAD_REPORT",
      EXIT.USAGE,
      `Not a tw2sx report: ${file}`,
      "Regenerate it with tw2sx plan.",
    );

  return report;
};

const printRefusals = (findings: Finding[], shown: Finding[]): void => {
  for (const f of shown) console.log(f.rendered);
  if (findings.length > shown.length)
    console.log(`\nShowing ${shown.length} of ${findings.length}.`);
};

export const refusalsCommand = (args: Args, out: Output): CommandResult => {
  // Bare `--json` with no value lists the field names (the `gh` pattern).
  if (flagBare(args, "json")) {
    console.log(FINDING_FIELDS.join("\n"));
    return { exit: EXIT.CLEAN };
  }

  const report = openReport(args);
  if (isError(report)) return report;

  const findings = filterFindings(report, args);
  const shown = findings.slice(0, out.limit);

  if (out.json) emit(shown.map(f => project(f, out.fields)));
  else printRefusals(findings, shown);

  return { exit: findings.length > 0 ? EXIT.REFUSALS : EXIT.CLEAN };
};

export { isError };
