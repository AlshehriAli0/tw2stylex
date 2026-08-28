#!/usr/bin/env node
import { parseArgs, positionalAt, flagPresent, type Args } from "./args.ts";
import {
  applyCommand,
  explainCommand,
  isError,
  planCommand,
  readOutput,
  refusalsCommand,
  type CommandResult,
} from "./commands.ts";
import { EXIT, fail } from "./report.ts";
import { REASONS } from "./reshape.ts";

const HELP = `tw2sx - migrate Tailwind v4 to StyleX.

Converts a style site only when it can prove the CSS declarations come out identical to what
Tailwind produced. Everything else it REFUSES and reports, with a reason and a fix.

COMMANDS  (read-only unless marked)
  tw2sx explain "<classes>"     Print the StyleX object for a class string, and whether it verified.
  tw2sx plan <path>             Convert + verify a tree. Writes a JSON report.
  tw2sx refusals <report.json>  Re-read a report, filtered.
  tw2sx apply <path> --write    WRITES CODE. Rewrites only the sites that verified.

TYPICAL RUN
  tw2sx plan src/components        # mismatches must be 0; refusals are the work
  tw2sx refusals .tw2sx/plan-*.json --applicability machine-applicable
  ...fix those, then re-run plan until the refusal count stops dropping

OPTIONS
  --css <file>        Tailwind entry CSS. Auto-detected from the target when omitted.
  --json[=<fields>]   JSON output. Bare --json lists the field names you can ask for.
  --limit <n>         Refusals printed (default 20). Use 0 for the summary alone.
  --reason <r>        Keep one reason code.
  --applicability <a> Keep one of: machine-applicable has-placeholders maybe-incorrect unspecified
  --out <file>        Report path (default .tw2sx/plan-<hash>.json).
  --write             apply only: edit files. Omitted, apply is a dry run.
  --allow-dirty       apply only: write over a tree with uncommitted changes.

A refusal carries a REASON (why it was refused) and an APPLICABILITY (what to do about it):
  machine-applicable  one right answer, safe to batch
  has-placeholders    you must locate something the tool could not (an ancestor, a child)
  maybe-incorrect     a rewrite exists but shifts behaviour at the edges; read the code first
  unspecified         investigate; often not a Tailwind class at all

REASON CODES
  ${REASONS.join(", ")}

EXIT  0 nothing refused · 1 completed with refusals · 2 usage · 3 precondition · 10 internal
Positions are 1-based line:column.`;

const report = (result: CommandResult, json: boolean): number => {
  if (!isError(result)) return result.exit;
  if (json) console.error(JSON.stringify(result, null, 2));
  else console.error(`tw2sx: ${result.message}\nhint: ${result.hint}\ncode: ${result.code}`);
  return result.exit_code;
};

const run = async (args: Args): Promise<CommandResult> => {
  const out = readOutput(args);
  switch (positionalAt(args, 0)) {
    case "explain":
      return await explainCommand(args, out);
    case "plan":
      return await planCommand(args, out);
    case "apply":
      return await applyCommand(args, out);
    case "refusals":
      return refusalsCommand(args, out);
    case undefined:
    default:
      return fail(
        "E_UNKNOWN_COMMAND",
        EXIT.USAGE,
        `Unknown command: ${positionalAt(args, 0) ?? "(none)"}`,
        "Run tw2sx help.",
      );
  }
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const command = positionalAt(args, 0);

  if (command === undefined || command === "help" || flagPresent(args, "help")) {
    console.log(HELP);
    return command === undefined ? EXIT.USAGE : EXIT.CLEAN;
  }

  return report(await run(args), readOutput(args).json);
};

try {
  process.exit(await main());
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(
    JSON.stringify(
      fail(
        "E_INTERNAL",
        EXIT.INTERNAL,
        message,
        "This is a tw2sx bug. Re-run with --json and file the output.",
      ),
      null,
      2,
    ),
  );
  process.exit(EXIT.INTERNAL);
}
