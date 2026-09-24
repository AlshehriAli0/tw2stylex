import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { convert, warmUp } from "./convert.ts";
import type { Converted } from "./convert.ts";
import { version } from "./init.ts";
import { toSkipLine, type FileResult, type Report } from "./report.ts";
import { importResolver } from "./resolve-import.ts";
import { scanFile } from "./scan-file.ts";
import type { ScanResult, Usage } from "./scan-file.ts";
import type { Skip } from "./skip.ts";
import {
  nameIsTaken,
  needsNameReview,
  newSheet,
  styleNameFor,
  styleObjectName,
} from "./style-name.ts";
import { loadDesignSystem, type LoadedSystem } from "./tailwind.ts";
import { loadTokens, mappedSource, tokenSkips } from "./tokens.ts";

const verdictFor = (total: number, converted: number, skipped: number): FileResult["verdict"] => {
  if (total === 0) return "unchanged";
  if (skipped === 0) return "converted";
  if (converted === 0) return "skipped";
  return "partial";
};

type Scanned = {
  file: string;
  code?: string;
  fingerprint: string;
  usages: ScanResult["usages"];
  imports: Record<string, string>;
  objectName: string;
  canApply: boolean;
};

const scanOne = (file: string, keepCode = false): Scanned => {
  const code = fs.readFileSync(file, "utf8");
  const { usages, imports, hasStyleX, styleXNamespace } = scanFile(code, file);
  return {
    file,
    code: keepCode ? code : undefined,
    fingerprint: crypto.createHash("sha1").update(code).digest("hex"),
    usages,
    imports: imports ?? {},
    objectName: usages.length > 0 ? styleObjectName(nameIsTaken(code)) : "styles",
    canApply: !hasStyleX || styleXNamespace !== undefined,
  };
};

const componentGroups = (scanned: Scanned[]): NonNullable<Report["components"]> => {
  const groups = new Map<string, NonNullable<Report["components"]>[number]>();
  const resolve = importResolver();
  for (const { file, usages, imports } of scanned)
    for (const usage of usages) {
      const name = usage.componentName;
      if (name === undefined) continue;
      const source = resolve(file, imports[name]);
      const key = `${name}\0${source}`;
      const group = groups.get(key) ?? { name, source, callers: [], skipCount: 0 };
      group.callers.push(`${file}:${usage.loc.line}:${usage.loc.column}`);
      group.skipCount += 1;
      groups.set(key, group);
    }
  return [...groups.values()];
};

const isCva = (usage: Usage): boolean => usage.kind === "cva-base" || usage.kind === "cva-variant";

const candidateIsClean = (usage: Usage, result: Converted, tokenProblems: Skip[]): boolean =>
  usage.skips.length === 0 &&
  result.skips.length === 0 &&
  tokenProblems.length === 0 &&
  !!result.style;

const resultFor = (
  sys: LoadedSystem,
  { file, code, usages, objectName, canApply }: Scanned,
): FileResult => {
  const lines: FileResult["skips"] = [];
  const mismatches: FileResult["mismatches"] = [];
  const sheet = newSheet();
  const used = new Set<string>();
  const reviewNames: string[] = [];
  const unresolvedClasses: string[] = [];
  let converted = 0;

  usages.forEach((usage, i) => {
    const name = styleNameFor(usage, i, used);
    const result = convert(sys.ds, name, usage.classNames);
    const tokenProblems = result.style ? tokenSkips(result.style, sys.tokens) : [];
    if (isCva(usage)) {
      if (!candidateIsClean(usage, result, tokenProblems))
        unresolvedClasses.push(...usage.classNames);
    }
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
    skips.push(...tokenProblems);

    for (const skip of skips) lines.push(toSkipLine(file, usage.loc.line, usage.loc.column, skip));
    mismatches.push(...result.mismatches);

    if (candidateIsClean(usage, result, tokenProblems) && result.style) {
      const shared = sheet.add(result.style, name);
      if (shared === name && needsNameReview(usage, name))
        reviewNames.push(`${name} (${file}:${usage.loc.line})`);
      if (!manual) converted += 1;
    }
  });

  const total = usages.length;
  const skipped = total - converted;
  const hasSource = Object.keys(sheet.styles).length > 0;
  const sourceStatus: FileResult["sourceStatus"] =
    hasSource && skipped > 0 ? "fragment" : undefined;
  const mapped = hasSource
    ? mappedSource({ styles: sheet.styles, tokens: sys.tokens, file, code: code ?? "", objectName })
    : undefined;
  return {
    file,
    verdict: verdictFor(total, converted, skipped),
    usages: total,
    converted,
    skipped,
    source: mapped ? [...mapped.imports, mapped.source].join("\n") : undefined,
    sourceStatus,
    unresolvedClasses: unresolvedClasses.length ? [...new Set(unresolvedClasses)] : undefined,
    reviewNames: reviewNames.length ? reviewNames : undefined,
    skips: lines,
    mismatches,
  };
};

export const processFile = (sys: LoadedSystem, file: string): FileResult =>
  resultFor(sys, scanOne(file, !!sys.tokens?.size));

export const plan = async (
  entryCss: string,
  files: string[],
  target = "",
  tokensPath?: string,
): Promise<Report> => {
  const sys = await loadDesignSystem(entryCss);
  if (tokensPath) sys.tokens = loadTokens(tokensPath);

  const scanned = files.map(file => scanOne(file, !!sys.tokens?.size));
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
    version: version(),
    tailwind: sys.version,
    entry: sys.entry,
    target: path.resolve(target || files[0] || entryCss),
    inputs: Object.fromEntries([
      [sys.entry, crypto.createHash("sha1").update(fs.readFileSync(sys.entry)).digest("hex")],
      ...scanned.map(s => [path.resolve(s.file), s.fingerprint]),
      ...(tokensPath
        ? [
            [
              path.resolve(tokensPath),
              crypto.createHash("sha1").update(fs.readFileSync(tokensPath)).digest("hex"),
            ],
          ]
        : []),
      ...[...new Set([...(sys.tokens?.values() ?? [])].map(token => token.file))]
        .filter(file => fs.existsSync(file))
        .map(file => [file, crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex")]),
    ]),
    components: componentGroups(scanned),
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
