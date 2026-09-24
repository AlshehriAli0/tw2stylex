import crypto from "node:crypto";
import fs from "node:fs";

import { positionalAt, type Args } from "./args.ts";
import { isRecord } from "./cjs.ts";
import { EXIT, fail, type Failure } from "./fail.ts";
import { collectFiles } from "./find-files.ts";
import { version } from "./init.ts";
import type { Report } from "./report.ts";

const isReport = (value: unknown): value is Report => isRecord(value) && Array.isArray(value.files);

export const reportWarnings = (report: Report): string[] => {
  const warnings: string[] = [];
  if (!report.inputs || !report.version || !report.target)
    return ["Report has no input fingerprints; regenerate it with tw2stylex plan."];
  const currentVersion = version();
  if (report.version !== currentVersion)
    warnings.push(`Tool changed: ${report.version} → ${currentVersion}.`);
  for (const [file, expected] of Object.entries(report.inputs)) {
    if (!fs.existsSync(file)) warnings.push(`Input removed: ${file}`);
    else if (crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex") !== expected)
      warnings.push(`Input changed: ${file}`);
  }
  if (fs.existsSync(report.target)) {
    for (const file of collectFiles(report.target))
      if (!(file in report.inputs)) warnings.push(`New input: ${file}`);
  } else warnings.push(`Target removed: ${report.target}`);
  return warnings;
};

export const openReport = (args: Args): Report | Failure => {
  const file = positionalAt(args, 1);
  if (file === undefined || !fs.existsSync(file))
    return fail(
      "E_NO_REPORT",
      EXIT.BAD_ARGUMENTS,
      `Report not found: ${file ?? "(none given)"}`,
      "Run tw2stylex plan <path> first.",
    );

  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isReport(parsed))
    return fail(
      "E_BAD_REPORT",
      EXIT.BAD_ARGUMENTS,
      `Not a tw2stylex report: ${file}`,
      "Regenerate it with tw2stylex plan.",
    );
  return parsed;
};
