import {
  APPLICABILITY,
  REASONS,
  type Applicability,
  type Reason,
  type Refusal,
} from "./reshape.ts";
import type { Mismatch } from "./verify.ts";

export type Finding = {
  file: string;
  line: number;
  column: number;
  reason: Reason;
  applicability: Applicability;
  candidate?: string;
  detail: string;
  hint: string;
  /** The human-rendered one-liner, so one --json run serves the parser and a PR description. */
  rendered: string;
};

export type FileResult = {
  file: string;
  verdict: "converted" | "partial" | "refused" | "unchanged";
  sites: number;
  converted: number;
  refused: number;
  /** stylex.create source for the sites that did convert. */
  source?: string;
  findings: Finding[];
  mismatches: Mismatch[];
};

export type Report = {
  ok: boolean;
  tool: string;
  tailwind: string;
  entry: string;
  summary: {
    files: number;
    sites: number;
    converted: number;
    refused: number;
    byReason: Record<string, number>;
    byApplicability: Record<string, number>;
  };
  files: FileResult[];
};

export const toFinding = (file: string, line: number, column: number, r: Refusal): Finding => {
  const applicability = r.applicability ?? APPLICABILITY[r.reason];
  return {
    file,
    line,
    column,
    reason: r.reason,
    applicability,
    candidate: r.candidate,
    detail: r.detail,
    hint: r.hint,
    rendered: `${file}:${line}:${column}: refused ${r.reason}${r.candidate ? ` "${r.candidate}"` : ""}: ${r.detail} help: ${r.hint}`,
  };
};

/** The order the work should be done in, so the summary reads as a plan. */
const WORK_ORDER: Applicability[] = [
  "machine-applicable",
  "has-placeholders",
  "maybe-incorrect",
  "unspecified",
];

const mismatchLine = (m: Mismatch): string =>
  `  ${m.namespace} [${m.condition}] ${m.property}: tailwind=${m.tailwind ?? "(none)"} stylex=${m.stylex ?? "(none)"}`;

/** Mismatches are a hard stop, so they print before anything the agent might act on. */
const mismatchSection = (report: Report, limit: number): string[] => {
  const all = report.files.flatMap(f => f.mismatches);
  const stop = all.length
    ? " - STOP: generated StyleX does not match Tailwind. This is a tw2sx bug."
    : "";
  return [`DECLARATION MISMATCHES: ${all.length}${stop}`, ...all.slice(0, limit).map(mismatchLine)];
};

/** Refusal counts, grouped so the list reads as the order to work them in. */
const refusalBreakdown = (byReason: Record<string, number>): string[] => {
  const lines: string[] = ["", "Refusals, in the order to work them:"];
  for (const applicability of WORK_ORDER) {
    const rows = Object.entries(byReason)
      .filter(([reason]) => applicabilityOf(reason) === applicability)
      .sort((a, b) => b[1] - a[1]);
    if (rows.length === 0) continue;
    lines.push(`  ${applicability}`);
    for (const [reason, n] of rows) lines.push(`    ${reason.padEnd(22)} ${String(n).padStart(4)}`);
  }
  return lines;
};

const findingsSection = (
  findings: Finding[],
  limit: number,
  byReason: Record<string, number>,
): string[] => {
  if (findings.length === 0) return [];
  const shown = findings.slice(0, limit).map(f => f.rendered);
  const elided =
    findings.length > limit ? [`\nShowing ${limit} of ${findings.length} refusals.`] : [];
  return ["", ...shown, ...elided, ...refusalBreakdown(byReason)];
};

const nextStepSection = (report: Report, reportPath: string | undefined): string[] => {
  if (reportPath === undefined) return [];
  const first = WORK_ORDER.find(a => report.summary.byApplicability[a]);
  const next =
    first === undefined
      ? []
      : [`Next: tw2sx refusals ${reportPath} --applicability ${first} --limit 20`];
  return ["", `Full report: ${reportPath}`, ...next];
};

/** oxlint's `agent` format: one line per finding, ~31 tokens each. The default. */
export const renderAgent = (report: Report, limit: number, reportPath?: string): string => {
  const { files, sites, converted, refused, byReason } = report.summary;
  return [
    // Verdict on line one - it survives truncation.
    `${files} files · ${sites} sites · ${converted} converted · ${refused} refused`,
    ...mismatchSection(report, limit),
    ...findingsSection(
      report.files.flatMap(f => f.findings),
      limit,
      byReason,
    ),
    ...nextStepSection(report, reportPath),
  ].join("\n");
};

const isReason = (v: string): v is Reason => (REASONS as readonly string[]).includes(v);

const applicabilityOf = (reason: string): Applicability =>
  isReason(reason) ? APPLICABILITY[reason] : "unspecified";

/** Error envelope. Every failure is shaped the same and carries a runnable hint. */
export type ErrorEnvelope = {
  ok: false;
  code: string;
  exit_code: number;
  message: string;
  hint: string;
};

export const fail = (
  code: string,
  exit_code: number,
  message: string,
  hint: string,
): ErrorEnvelope => ({
  ok: false,
  code,
  exit_code,
  message,
  hint,
});

export const EXIT = {
  CLEAN: 0,
  REFUSALS: 1,
  USAGE: 2,
  PRECONDITION: 3,
  INTERNAL: 10,
} as const;
