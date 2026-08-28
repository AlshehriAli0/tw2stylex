import { fixFor, FIXES, type Fix, type Reason, type Skip } from "./skip.ts";
import type { Mismatch } from "./verify.ts";

/** One skip, placed in a file and ready to print. */
export type SkipLine = {
  file: string;
  line: number;
  column: number;
  reason: Reason;
  fix: Fix;
  class?: string;
  detail: string;
  hint: string;
  /** The one-line rendering, so a JSON reader also gets something paste-ready. */
  message: string;
};

export type FileResult = {
  file: string;
  verdict: "converted" | "partial" | "skipped" | "unchanged";
  usages: number;
  converted: number;
  skipped: number;
  /** `stylex.create` source for the usages that did convert. */
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

/** The order to work skips in: bulk-safe first, guesswork last. */
const WORK_ORDER: Fix[] = ["safe", "needs-lookup", "check-first", "unknown"];

const mismatchLine = (m: Mismatch): string =>
  `  ${m.styleName} [${m.condition}] ${m.property}: tailwind=${m.tailwind ?? "(none)"} stylex=${m.stylex ?? "(none)"}`;

/** Mismatches are a hard stop, so they print before anything the agent might act on. */
const mismatchSection = (report: Report, limit: number): string[] => {
  const all = report.files.flatMap(f => f.mismatches);
  const stop =
    all.length > 0 ? " - STOP: our StyleX does not match Tailwind. This is a tw2sx bug." : "";
  return [`MISMATCHES: ${all.length}${stop}`, ...all.slice(0, limit).map(mismatchLine)];
};

/**
 * Counts per (fix, reason), read off each skip.
 *
 * Reading the fix off the skip rather than recomputing it from the reason matters: a skip can
 * override the default, and this table sits directly beside a `Next:` line built from the same
 * skips. Recomputing here made the two disagree.
 */
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
    lines.push(`  ${fix}`);
    for (const [reason, n] of rows) lines.push(`    ${reason.padEnd(22)} ${String(n).padStart(4)}`);
  }
  return lines;
};

const skipSection = (skips: SkipLine[], limit: number): string[] => {
  if (skips.length === 0) return [];
  const shown = skips.slice(0, limit).map(s => s.message);
  const elided = skips.length > limit ? [`\nShowing ${limit} of ${skips.length} skipped.`] : [];
  return ["", ...shown, ...elided, ...breakdown(skips)];
};

const nextStep = (skips: SkipLine[], reportPath: string | undefined): string[] => {
  if (reportPath === undefined) return [];
  const first = WORK_ORDER.find(fix => skips.some(s => s.fix === fix));
  const next =
    first === undefined ? [] : [`Next: tw2sx skipped ${reportPath} --fix ${first} --limit 20`];
  return ["", `Full report: ${reportPath}`, ...next];
};

/** One line per skip, so an agent can read the whole thing cheaply. The default output. */
export const renderReport = (report: Report, limit: number, reportPath?: string): string => {
  const { files, usages, converted, skipped } = report.summary;
  const skips = report.files.flatMap(f => f.skips);
  return [
    // Verdict on line one - it survives truncation.
    `${files} files · ${usages} usages · ${converted} converted · ${skipped} skipped`,
    ...mismatchSection(report, limit),
    ...skipSection(skips, limit),
    ...nextStep(skips, reportPath),
  ].join("\n");
};
