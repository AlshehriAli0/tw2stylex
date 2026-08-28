import fs from "node:fs";

import { convert } from "./convert.ts";
import { printCreate, type Style } from "./emit.ts";
import { scanFile } from "./extract.ts";
import { toSkipLine, type FileResult, type Report } from "./report.ts";
import { loadDesignSystem, type LoadedSystem } from "./resolve.ts";
import { styleNameFor } from "./style-name.ts";

const verdictFor = (total: number, converted: number, skipped: number): FileResult["verdict"] => {
  if (total === 0) return "unchanged";
  if (skipped === 0) return "converted";
  if (converted === 0) return "skipped";
  return "partial";
};

/**
 * Convert one file's usages. Every decision about what counts as converted lives in
 * `convert()`, so `plan` and `apply` cannot drift apart on it.
 */
export const processFile = (sys: LoadedSystem, file: string): FileResult => {
  const { usages } = scanFile(fs.readFileSync(file, "utf8"), file);
  const lines: FileResult["skips"] = [];
  const mismatches: FileResult["mismatches"] = [];
  const styles: Record<string, Style> = {};
  const used = new Set<string>();
  let converted = 0;

  usages.forEach((usage, i) => {
    const name = styleNameFor(usage, i, used);
    const result = convert(sys.ds, name, usage.classNames);
    const skips = [...usage.skips, ...result.skips];

    for (const skip of skips) lines.push(toSkipLine(file, usage.loc.line, usage.loc.column, skip));
    mismatches.push(...result.mismatches);

    // A usage converts only when nothing about it was skipped - what `apply` will also do.
    if (skips.length === 0 && result.style) {
      styles[name] = result.style;
      converted += 1;
    }
  });

  const total = usages.length;
  const skipped = total - converted;
  return {
    file,
    verdict: verdictFor(total, converted, skipped),
    usages: total,
    converted,
    skipped,
    source: Object.keys(styles).length > 0 ? printCreate(styles) : undefined,
    skips: lines,
    mismatches,
  };
};

export const plan = async (entryCss: string, files: string[]): Promise<Report> => {
  const sys = await loadDesignSystem(entryCss);
  const results = files.map(f => processFile(sys, f));

  const byReason: Record<string, number> = {};
  const byFix: Record<string, number> = {};
  for (const result of results)
    for (const skip of result.skips) {
      byReason[skip.reason] = (byReason[skip.reason] ?? 0) + 1;
      byFix[skip.fix] = (byFix[skip.fix] ?? 0) + 1;
    }

  const sum = (k: "usages" | "converted" | "skipped"): number =>
    results.reduce((a, r) => a + r[k], 0);

  return {
    ok: results.every(r => r.mismatches.length === 0),
    tool: "tw2sx",
    tailwind: sys.version,
    entry: sys.entry,
    summary: {
      files: results.length,
      usages: sum("usages"),
      converted: sum("converted"),
      skipped: sum("skipped"),
      byReason,
      byFix,
    },
    files: results,
  };
};
