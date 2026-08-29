import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { applyScanned, dirtyFiles, readAndScan, type ApplyFileResult } from "./apply.ts";
import {
  flagWithoutValue,
  flagNumber,
  flagWasPassed,
  flagString,
  positionalAt,
  type Args,
} from "./args.ts";
import { isRecord } from "./cjs.ts";
import { bold, cyan, dim, FIX_COLOR, green } from "./color.ts";
import { convert, warmUp } from "./convert.ts";
import { printCreate, type Style } from "./css-to-stylex.ts";
import { EXIT, fail, type Failure } from "./fail.ts";
import { collectFiles, findConfig, findEntryCss } from "./find-files.ts";
import { AGENT_HOMES, homesPresent, ignoreReports, installSkill, installedSkills } from "./init.ts";
import { plan } from "./plan.ts";
import { paintSkip, renderReport, toSkipLine, took, type Report, type SkipLine } from "./report.ts";
import { loadDesignSystem, type LoadedSystem } from "./tailwind.ts";

export type CommandResult = { exit: number } | Failure;

const isError = (r: object): r is Failure => "code" in r && typeof r.code === "string";

export const SKIP_FIELDS = [
  "file",
  "line",
  "column",
  "reason",
  "fix",
  "class",
  "detail",
  "hint",
  "message",
];

export type Output = { json: boolean; fields: string[] | undefined; limit: number };

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

const project = (finding: SkipLine, fields: string[] | undefined): Record<string, unknown> => {
  if (!fields?.length) return { ...finding };
  const out: Record<string, unknown> = {};
  const bag: Record<string, unknown> = { ...finding };
  for (const field of fields) if (field in bag) out[field] = bag[field];
  return out;
};

const containingDir = (target: string): string =>
  fs.statSync(target).isDirectory() ? target : path.dirname(target);

const entryFor = (args: Args, from: string, retry: string): string | Failure =>
  flagString(args, "css") ??
  flagString(args, "config") ??
  findEntryCss(from) ??
  findConfig(from) ??
  fail(
    "E_NO_TAILWIND_ENTRY",
    EXIT.NOT_READY,
    "Could not find your Tailwind setup: no entry CSS, no tailwind.config file.",
    `Point at one: ${retry} --css src/index.css, or ${retry} --config tailwind.config.js`,
  );

const requireExistingPath = (target: string | undefined, usage: string): string | Failure => {
  if (target === undefined) return fail("E_NO_INPUT", EXIT.BAD_ARGUMENTS, "No path given.", usage);
  if (!fs.existsSync(target))
    return fail("E_NO_SUCH_PATH", EXIT.BAD_ARGUMENTS, `Path not found: ${target}`, usage);
  return target;
};

const readTheSkill = (root = process.cwd()): string => {
  const skill = installedSkills(root)[0];
  return skill === undefined
    ? `${dim("Skill:")} run ${cyan("tw2sx init")}, then read the SKILL.md it writes in full before working the skips.`
    : `${dim("Skill:")} read ${cyan(skill)} in full before working the skips.`;
};

const homesToWrite = (args: Args, root: string): string[] => {
  const present = homesPresent(root);
  const every = flagWasPassed(args, "all") || present.length === 0;
  return every ? AGENT_HOMES.map(h => h.home) : present;
};

export const initCommand = (args: Args, out: Output): CommandResult => {
  const root = process.cwd();
  const installed = installSkill(root, homesToWrite(args, root));
  ignoreReports(root);
  if (out.json) emit(installed);
  else {
    console.log(`tw2sx ${installed.version}: skill installed`);
    for (const destination of installed.destinations) console.log(`  ${destination}`);
    console.log(`  .gitignore ignores ${dim(".tw2sx/")}`);
    console.log(`\n${readTheSkill(root)}`);
  }
  return { exit: EXIT.NOTHING_SKIPPED };
};

const classStringsToExplain = (args: Args): string[] => {
  const lines = flagWasPassed(args, "stdin")
    ? fs.readFileSync(0, "utf8").split("\n")
    : [args.positional.slice(1).join(" ")];
  return lines.map(line => line.trim()).filter(Boolean);
};

type Explained = {
  input: string;
  style?: Style;
  rules: number;
  source?: string;
  skipped: SkipLine[];
};

const explain = (sys: LoadedSystem, input: string): Explained => {
  const { style, rules, skips } = convert(sys.ds, "styles", input.split(/\s+/));
  return {
    input,
    style,
    rules,
    source: style ? printCreate({ styles: style }) : undefined,
    skipped: skips.map(s => toSkipLine("<argv>", 0, 0, s)),
  };
};

const explainedJson = (sys: LoadedSystem, e: Explained): unknown => ({
  ok: e.skipped.length === 0,
  input: e.input,
  entry: sys.entry,
  tailwind: sys.version,
  stylex: e.style,
  source: e.source,
  skipped: e.skipped,
});

const printExplained = ({ source, skipped, style, rules }: Explained): void => {
  if (source !== undefined) console.log(source);
  for (const skip of skipped)
    console.log(
      `skipped ${FIX_COLOR[skip.fix](skip.reason)}` +
        `${skip.class === undefined ? "" : ` ${bold(`"${skip.class}"`)}`}: ${skip.detail}` +
        `\n  ${dim("fix:")} ${skip.hint}`,
    );
  console.log("");
  console.log(
    style
      ? green(`checked: same declarations as Tailwind (${rules} atomic rules)`)
      : dim(`not converted: ${skipped.length} skipped`),
  );
};

export const explainCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const inputs = classStringsToExplain(args);
  if (inputs.length === 0)
    return fail(
      "E_NO_INPUT",
      EXIT.BAD_ARGUMENTS,
      "No classes given.",
      'tw2sx explain "flex items-center p-4", or --stdin with one class string per line',
    );

  const css = entryFor(args, process.cwd(), "tw2sx explain <classes>");
  if (typeof css !== "string") return css;

  const sys = await loadDesignSystem(css);
  const explained = inputs.map(input => explain(sys, input));
  const fromStdin = flagWasPassed(args, "stdin");

  if (out.json) {
    const body = explained.map(e => explainedJson(sys, e));
    emit(fromStdin ? body : body[0]);
  } else
    for (const e of explained) {
      if (fromStdin) console.log(cyan(`> ${e.input}`));
      printExplained(e);
    }

  const anySkipped = explained.some(e => e.skipped.length > 0);
  return { exit: anySkipped ? EXIT.SOME_SKIPPED : EXIT.NOTHING_SKIPPED };
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
    usages: f.usages,
    converted: f.converted,
    skipped: f.skipped,
    skips: f.skips.map(x => project(x, fields)),
  })),
});

const planExit = (report: Report): number => {
  if (!report.ok) return EXIT.OUR_BUG;
  return report.summary.skipped > 0 ? EXIT.SOME_SKIPPED : EXIT.NOTHING_SKIPPED;
};

export const planCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const target = requireExistingPath(positionalAt(args, 1), "tw2sx plan src/components/ui");
  if (typeof target !== "string") return target;

  const css = entryFor(args, containingDir(target), `tw2sx plan ${target}`);
  if (typeof css !== "string") return css;

  const startedAt = Date.now();
  const files = collectFiles(target);
  const report = await plan(css, files);
  const elapsedMs = Date.now() - startedAt;

  const hash = crypto.createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 6);
  const reportPath = flagString(args, "out") ?? path.join(".tw2sx", `plan-${hash}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (out.json) emit(summarise(report, out.fields));
  else console.log(`${renderReport(report, out.limit, reportPath, elapsedMs)}\n${readTheSkill()}`);

  return { exit: planExit(report) };
};

const writeWouldClobber = (args: Args, target: string, write: boolean): boolean =>
  write && !flagWasPassed(args, "allow-dirty");

const dirtyGuard = (target: string): Failure | undefined => {
  const dirty = dirtyFiles(path.resolve(containingDir(target)));
  if (!dirty || dirty.length === 0) return undefined;
  return fail(
    "E_DIRTY_TREE",
    EXIT.NOT_READY,
    `Refusing to write: ${dirty.length} uncommitted change(s) under ${target}.\n  ${dirty.slice(0, 5).join("\n  ")}`,
    "Commit or stash first, or re-run with --allow-dirty (your edits will be interleaved and hard to revert).",
  );
};

const sumOf = (results: ApplyFileResult[], key: "rewritten" | "skipped"): number =>
  results.reduce((total, r) => total + r[key], 0);

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
  elapsedMs: number;
};

const printApply = (p: ApplyPrint): void => {
  const { touched, write, rewritten, skipped, target, limit, elapsedMs } = p;
  const mode = write ? "" : dim("  (DRY RUN - pass --write to edit)");
  console.log(
    `${bold(String(touched.length))} files · ${green(bold(String(rewritten)))} usages rewritten · ` +
      `${bold(String(skipped))} left for you${dim(` · ${took(elapsedMs)}`)}${mode}`,
  );
  for (const r of touched.slice(0, limit))
    console.log(`  ${dim(r.file)}: ${r.rewritten} rewritten, ${r.skipped} skipped`);
  if (touched.length > limit)
    console.log(`\n${dim(`Showing ${limit} of ${touched.length} files.`)}`);
  if (!write && touched.length > 0)
    console.log(`\n${dim("Next:")} ${cyan(`tw2sx apply ${target} --write`)}`);
};

export const applyCommand = async (args: Args, out: Output): Promise<CommandResult> => {
  const target = requireExistingPath(positionalAt(args, 1), "tw2sx apply src/components/ui");
  if (typeof target !== "string") return target;

  const write = flagWithoutValue(args, "write");
  const blocked = writeWouldClobber(args, target, write) ? dirtyGuard(target) : undefined;
  if (blocked) return blocked;

  const css = entryFor(args, containingDir(target), `tw2sx apply ${target}`);
  if (typeof css !== "string") return css;

  const startedAt = Date.now();
  const sys = await loadDesignSystem(css);
  const scanned = collectFiles(target).map(readAndScan);
  warmUp(
    sys.ds,
    scanned.flatMap(s => s.scan.usages.map(u => u.classNames)),
  );
  const results = scanned.map(s => applyScanned(sys, s, write));
  const touched = results.filter(r => r.rewritten > 0);
  const rewritten = sumOf(touched, "rewritten");
  const skipped = sumOf(results, "skipped");

  if (out.json) emit(applyJson(touched, write, rewritten, skipped));
  else
    printApply({
      touched,
      write,
      rewritten,
      skipped,
      target,
      limit: out.limit,
      elapsedMs: Date.now() - startedAt,
    });

  return { exit: skipped > 0 ? EXIT.SOME_SKIPPED : EXIT.NOTHING_SKIPPED };
};

const isReport = (v: unknown): v is Report => isRecord(v) && Array.isArray(v.files);

const readReport = (file: string): Report | undefined => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return isReport(parsed) ? parsed : undefined;
};

const filterSkips = (report: Report, args: Args): SkipLine[] => {
  const reason = flagString(args, "reason");
  const fix = flagString(args, "fix");
  return report.files
    .flatMap(f => f.skips)
    .filter(f => reason === undefined || f.reason === reason)
    .filter(f => fix === undefined || f.fix === fix);
};

const openReport = (args: Args): Report | Failure => {
  const file = positionalAt(args, 1);
  if (file === undefined || !fs.existsSync(file))
    return fail(
      "E_NO_REPORT",
      EXIT.BAD_ARGUMENTS,
      `Report not found: ${file ?? "(none given)"}`,
      "Run tw2sx plan <path> first.",
    );

  const report = readReport(file);
  if (!report)
    return fail(
      "E_BAD_REPORT",
      EXIT.BAD_ARGUMENTS,
      `Not a tw2sx report: ${file}`,
      "Regenerate it with tw2sx plan.",
    );

  return report;
};

const printSkips = (skips: SkipLine[], shown: SkipLine[]): void => {
  for (const f of shown) console.log(paintSkip(f));
  if (skips.length > shown.length)
    console.log(`\n${dim(`Showing ${shown.length} of ${skips.length}.`)}`);
};

export const skippedCommand = (args: Args, out: Output): CommandResult => {
  if (flagWithoutValue(args, "json")) {
    console.log(SKIP_FIELDS.join("\n"));
    return { exit: EXIT.NOTHING_SKIPPED };
  }

  const report = openReport(args);
  if (isError(report)) return report;

  const skips = filterSkips(report, args);
  const shown = skips.slice(0, out.limit);

  if (out.json) emit(shown.map(f => project(f, out.fields)));
  else printSkips(skips, shown);

  return { exit: skips.length > 0 ? EXIT.SOME_SKIPPED : EXIT.NOTHING_SKIPPED };
};

export { isError };
