import fs from "node:fs";

import { convert, warmUp } from "./convert.ts";
import { printCreate } from "./css-to-stylex.ts";
import { toSkipLine, type FileResult, type Report } from "./report.ts";
import { scanFile, type ScanResult } from "./scan-file.ts";
import { nameIsTaken, newSheet, styleNameFor, styleObjectName } from "./style-name.ts";
import { loadDesignSystem, type LoadedSystem } from "./tailwind.ts";

const verdictFor = (total: number, converted: number, skipped: number): FileResult["verdict"] => {
  if (total === 0) return "unchanged";
  if (skipped === 0) return "converted";
  if (converted === 0) return "skipped";
  return "partial";
};

type Scanned = {
  file: string;
  usages: ScanResult["usages"];
  objectName: string;
  canApply: boolean;
};

const scanOne = (file: string): Scanned => {
  const code = fs.readFileSync(file, "utf8");
  const { usages, hasStyleX, styleXNamespace } = scanFile(code, file);
  return {
    file,
    usages,
    objectName: usages.length > 0 ? styleObjectName(nameIsTaken(code)) : "styles",
    canApply: !hasStyleX || styleXNamespace !== undefined,
  };
};

const resultFor = (
  sys: LoadedSystem,
  { file, usages, objectName, canApply }: Scanned,
): FileResult => {
  const lines: FileResult["skips"] = [];
  const mismatches: FileResult["mismatches"] = [];
  const sheet = newSheet();
  const used = new Set<string>();
  let converted = 0;

  usages.forEach((usage, i) => {
    const name = styleNameFor(usage, i, used);
    const result = convert(sys.ds, name, usage.classNames);
    const manual = !canApply || usage.attributeRange === undefined;
    const skips = [...usage.skips];
    if (manual)
      skips.push({
        reason: "manual-rewrite",
        detail: canApply
          ? "This cva() definition needs a manual rewrite."
          : "This file imports StyleX without a namespace import that apply can reuse.",
        hint: canApply
          ? "Convert the cva() variants and their call sites together by hand."
          : "Use a namespace import from @stylexjs/stylex, then run plan again.",
      });
    skips.push(...result.skips);

    for (const skip of skips) lines.push(toSkipLine(file, usage.loc.line, usage.loc.column, skip));
    mismatches.push(...result.mismatches);

    if (usage.skips.length === 0 && result.skips.length === 0 && result.style) {
      sheet.add(result.style, name);
      if (!manual) converted += 1;
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
    source:
      Object.keys(sheet.styles).length > 0 ? printCreate(sheet.styles, objectName) : undefined,
    skips: lines,
    mismatches,
  };
};

export const processFile = (sys: LoadedSystem, file: string): FileResult =>
  resultFor(sys, scanOne(file));

export const plan = async (entryCss: string, files: string[]): Promise<Report> => {
  const sys = await loadDesignSystem(entryCss);

  const scanned = files.map(scanOne);
  warmUp(
    sys.ds,
    scanned.flatMap(s => s.usages.map(u => u.classNames)),
  );
  const results = scanned.map(s => resultFor(sys, s));

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
    tool: "tw2stylex",
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
