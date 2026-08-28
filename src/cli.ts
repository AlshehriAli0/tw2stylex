#!/usr/bin/env node
import { parseArgs, positionalAt, flagWasPassed, type Args } from "./args.ts";
import {
  applyCommand,
  explainCommand,
  isError,
  planCommand,
  readOutput,
  skippedCommand,
  type CommandResult,
} from "./commands.ts";
import { EXIT, fail } from "./fail.ts";
import { FIX_MEANING, FIXES, REASONS } from "./skip.ts";

const HELP = `tw2sx - convert Tailwind v4 to StyleX.

Converts a usage only when it can prove the CSS comes out the same as Tailwind produced.
Everything else it SKIPS and lists, with a reason and how to fix it.

COMMANDS  (nothing writes unless you say --write)
  tw2sx explain "<classes>"    Show the StyleX for a class string, and whether it checks out.
  tw2sx plan <path>            Convert + check a folder. Writes a JSON report.
  tw2sx skipped <report.json>  Re-read a report, filtered.
  tw2sx apply <path> --write   WRITES CODE. Rewrites only what converted cleanly.

A TYPICAL RUN
  tw2sx plan src/components        # MISMATCHES must be 0; the skips are the work
  tw2sx skipped .tw2sx/plan-*.json --fix safe
  ...fix those, re-run plan, repeat until the skip count stops dropping

OPTIONS
  --css <file>        Your Tailwind entry CSS. Found automatically if you leave it out.
  --json[=<fields>]   JSON output. Plain --json lists the field names you can ask for.
  --limit <n>         How many skips to print (default 20). Use 0 for just the summary.
  --reason <r>        Show one reason only.
  --fix <f>           Show one fix type only.
  --out <file>        Where to write the report (default .tw2sx/plan-<hash>.json).
  --write             apply only: actually edit files. Without it, apply is a dry run.
  --allow-dirty       apply only: write even with uncommitted changes.

Every skip says WHY it was skipped (the reason) and HOW HARD it is to fix:
${FIXES.map(f => `  ${f.padEnd(13)} ${FIX_MEANING[f]}`).join("\n")}

REASONS
  ${REASONS.join(", ")}

EXIT  0 nothing skipped · 1 finished with skips · 2 bad arguments · 3 not ready · 10 our bug
Line and column numbers start at 1.`;

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
    case "skipped":
      return skippedCommand(args, out);
    case undefined:
    default:
      return fail(
        "E_UNKNOWN_COMMAND",
        EXIT.BAD_ARGUMENTS,
        `Unknown command: ${positionalAt(args, 0) ?? "(none)"}`,
        "Run tw2sx help.",
      );
  }
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const command = positionalAt(args, 0);

  if (command === undefined || command === "help" || flagWasPassed(args, "help")) {
    console.log(HELP);
    return command === undefined ? EXIT.BAD_ARGUMENTS : EXIT.NOTHING_SKIPPED;
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
        EXIT.OUR_BUG,
        message,
        "This is a tw2sx bug. Re-run with --json and file the output.",
      ),
      null,
      2,
    ),
  );
  process.exit(EXIT.OUR_BUG);
}
