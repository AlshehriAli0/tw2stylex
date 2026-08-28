import { APPLICABILITY, type Applicability, type Reason, type Refusal } from './reshape.ts';
import type { Mismatch } from './verify.ts';

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
  verdict: 'converted' | 'partial' | 'refused' | 'unchanged';
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
    rendered: `${file}:${line}:${column}: refused ${r.reason}${r.candidate ? ` "${r.candidate}"` : ''}: ${r.detail} help: ${r.hint}`,
  };
};

/** The order the work should be done in, so the summary reads as a plan. */
const ORDER: Applicability[] = ['machine-applicable', 'has-placeholders', 'maybe-incorrect', 'unspecified'];

/** oxlint's `agent` format: one line per finding, ~31 tokens each. The default. */
export function renderAgent(report: Report, limit: number, reportPath?: string): string {
  const s = report.summary;
  const out: string[] = [];
  // Verdict on line one - it survives truncation.
  out.push(`${s.files} files · ${s.sites} sites · ${s.converted} converted · ${s.refused} refused`);

  // Mismatches are a hard stop, so they come before anything the agent might act on.
  const mism = report.files.flatMap((f) => f.mismatches);
  out.push(`DECLARATION MISMATCHES: ${mism.length}${mism.length ? ' - STOP: generated StyleX does not match Tailwind. This is a tw2sx bug.' : ''}`);
  for (const m of mism.slice(0, limit))
    out.push(`  ${m.namespace} [${m.condition}] ${m.property}: tailwind=${m.tailwind ?? '(none)'} stylex=${m.stylex ?? '(none)'}`);

  const all = report.files.flatMap((f) => f.findings);
  if (all.length) {
    out.push('');
    for (const f of all.slice(0, limit)) out.push(f.rendered);
    if (all.length > limit) out.push(`\nShowing ${limit} of ${all.length} refusals.`);

    out.push('');
    out.push('Refusals, in the order to work them:');
    for (const app of ORDER) {
      const rows = Object.entries(s.byReason)
        .filter(([r]) => applicabilityOf(r) === app)
        .sort((a, b) => b[1] - a[1]);
      if (!rows.length) continue;
      out.push(`  ${app}`);
      for (const [reason, n] of rows) out.push(`    ${reason.padEnd(22)} ${String(n).padStart(4)}`);
    }
  }

  if (reportPath) {
    out.push('');
    out.push(`Full report: ${reportPath}`);
    const first = ORDER.find((a) => s.byApplicability[a]);
    if (first) out.push(`Next: tw2sx refusals ${reportPath} --applicability ${first} --limit 20`);
  }
  return out.join('\n');
}

const applicabilityOf = (reason: string) => APPLICABILITY[reason as Reason] ?? 'unspecified';

/** Error envelope. Every failure is shaped the same and carries a runnable hint. */
export type ErrorEnvelope = { ok: false; code: string; exit_code: number; message: string; hint: string };

export const fail = (code: string, exit_code: number, message: string, hint: string): ErrorEnvelope => ({
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
