import type { Mismatch } from "./check.ts";
import { bold, cyan, dim, FIX_COLOR, green, red } from "./color.ts";
import { fixFor, FIXES, type Fix, type Reason, type Skip } from "./skip.ts";

export type SkipLine = {
  file: string;
  line: number;
  column: number;
  reason: Reason;
  fix: Fix;
  class?: string;
  detail: string;
  hint: string;
  message: string;
};

export type FileResult = {
  file: string;
  verdict: "converted" | "partial" | "skipped" | "unchanged";
  usages: number;
  converted: number;
  skipped: number;
  source?: string;
  skips: SkipLine[];
  mismatches: Mismatch[];
};

export type Report = {
  ok: boolean;
  tool: string;
  tailwind: string;
  entry: string;
  summary: {
    files: number;
    usages: number;
    converted: number;
    skipped: number;
    byReason: Record<string, number>;
    byFix: Record<string, number>;
  };
  files: FileResult[];
};

export const toSkipLine = (file: string, line: number, column: number, skip: Skip): SkipLine => {
  const named = skip.class === undefined ? "" : ` "${skip.class}"`;
  return {
    file,
    line,
    column,
    reason: skip.reason,
    fix: fixFor(skip),
    class: skip.class,
    detail: skip.detail,
    hint: skip.hint,
    message: `${file}:${line}:${column}: skipped ${skip.reason}${named}: ${skip.detail} fix: ${skip.hint}`,
  };
};

const WORK_ORDER: Fix[] = ["safe", "needs-lookup", "check-first", "unknown"];

const mismatchLine = (m: Mismatch): string =>
  `  ${m.styleName} [${m.condition}] ${m.property}: tailwind=${m.tailwind ?? "(none)"} stylex=${m.stylex ?? "(none)"}`;

const mismatchSection = (report: Report, limit: number): string[] => {
  const all = report.files.flatMap(f => f.mismatches);
  if (all.length === 0) return [green("MISMATCHES: 0")];
  return [
    bold(red(`MISMATCHES: ${all.length}`)) +
      red(" - STOP: our StyleX does not match Tailwind. This is a tw2sx bug."),
    ...all.slice(0, limit).map(m => red(mismatchLine(m))),
  ];
};

const countByFixAndReason = (skips: SkipLine[]): Map<Fix, Map<string, number>> => {
  const counts = new Map<Fix, Map<string, number>>(FIXES.map(fix => [fix, new Map()]));
  for (const skip of skips) {
    const byReason = counts.get(skip.fix);
    byReason?.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
  }
  return counts;
};

const breakdown = (skips: SkipLine[]): string[] => {
  const counts = countByFixAndReason(skips);
  const lines: string[] = ["", "Skipped, in the order to work them:"];
  for (const fix of WORK_ORDER) {
    const rows = [...(counts.get(fix) ?? [])].sort((a, b) => b[1] - a[1]);
    if (rows.length === 0) continue;
    lines.push(`  ${FIX_COLOR[fix](fix)}`);
    for (const [reason, n] of rows)
      lines.push(`    ${dim(reason.padEnd(22))} ${bold(String(n).padStart(4))}`);
  }
  return lines;
};

export const paintSkip = (s: SkipLine): string => {
  const named = s.class === undefined ? "" : ` ${bold(`"${s.class}"`)}`;
  return (
    `${dim(`${s.file}:${s.line}:${s.column}:`)} skipped ${FIX_COLOR[s.fix](s.reason)}${named}: ` +
    `${s.detail} ${dim("fix:")} ${s.hint}`
  );
};

const skipSection = (skips: SkipLine[], limit: number): string[] => {
  if (skips.length === 0) return [];
  const shown = skips.slice(0, limit).map(paintSkip);
  const elided = skips.length > limit ? [`\nShowing ${limit} of ${skips.length} skipped.`] : [];
  return ["", ...shown, ...elided, ...breakdown(skips)];
};

const nextStep = (skips: SkipLine[], reportPath: string | undefined): string[] => {
  if (reportPath === undefined) return [];
  const first = WORK_ORDER.find(fix => skips.some(s => s.fix === fix));
  const next =
    first === undefined
      ? []
      : [`${dim("Next:")} ${cyan(`tw2sx skipped ${reportPath} --fix ${first} --limit 20`)}`];
  return ["", `${dim("Full report:")} ${reportPath}`, ...next];
};

const countOf = (skipped: number): string =>
  skipped === 0 ? green(bold("0")) : FIX_COLOR["check-first"](bold(String(skipped)));

export const took = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

export const renderReport = (
  report: Report,
  limit: number,
  reportPath?: string,
  elapsedMs?: number,
): string => {
  const { files, usages, converted, skipped } = report.summary;
  const skips = report.files.flatMap(f => f.skips);
  const elapsed = elapsedMs === undefined ? "" : dim(` · ${took(elapsedMs)}`);
  return [
    `${bold(String(files))} files · ${bold(String(usages))} usages · ` +
      `${green(bold(String(converted)))} converted · ${countOf(skipped)} skipped${elapsed}`,
    ...mismatchSection(report, limit),
    ...skipSection(skips, limit),
    ...nextStep(skips, reportPath),
  ].join("\n");
};
