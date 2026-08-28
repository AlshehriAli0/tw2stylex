import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, type Args } from "../src/args.ts";
import {
  applyCommand,
  explainCommand,
  isError,
  planCommand,
  readOutput,
  skippedCommand,
  SKIP_FIELDS,
  type CommandResult,
} from "../src/commands.ts";
import { EXIT } from "../src/exit.ts";
import { isRecord } from "../src/interop.ts";

/**
 * The command layer: what an agent actually sees. Exit codes, error codes and the shape of
 * `--json` are the contract - a reworded message is fine, a changed `code` is not.
 */
let dir: string;
let css: string;

const write = (name: string, code: string): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
  return file;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(import.meta.dir, "tmp-cmd-"));
  css = path.join(dir, "index.css");
  fs.copyFileSync(path.join(import.meta.dir, "fixture.css"), css);
  write("src/clean.tsx", `export const A = () => <div className="flex p-4" />;\n`);
  write("src/messy.tsx", `export const B = () => <div className="dark:text-white group" />;\n`);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Run = { out: string; err: string; result: CommandResult };

type Output = ReturnType<typeof readOutput>;
type Command = (args: Args, out: Output) => Promise<CommandResult> | CommandResult;

const COMMANDS: Record<string, Command> = {
  explain: explainCommand,
  plan: planCommand,
  apply: applyCommand,
  skipped: skippedCommand,
};

const run = async (line: string): Promise<Run> => {
  const args = parseArgs([...line.split(" ").filter(Boolean), "--css", css]);
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]): void => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]): void => {
    err.push(a.map(String).join(" "));
  };
  try {
    const command = COMMANDS[args.positional[0] ?? ""] ?? skippedCommand;
    const result = await command(args, readOutput(args));
    return { out: out.join("\n"), err: err.join("\n"), result };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
};

const exitOf = (r: CommandResult): number => (isError(r) ? r.exit_code : r.exit);
const codeOf = (r: CommandResult): string | undefined => (isError(r) ? r.code : undefined);

const json = (text: string): unknown => JSON.parse(text);
const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

describe("explain answers about a class string without touching the disk", () => {
  test("clean classes print the StyleX and say it checked out", async () => {
    const r = await run("explain flex items-center");
    expect(r.out).toContain("stylex.create");
    expect(r.out).toContain("checked: same declarations as Tailwind");
    expect(exitOf(r.result)).toBe(EXIT.CLEAN);
  });

  test("a skipped class exits 1 and says why and what to do", async () => {
    const r = await run("explain dark:text-white");
    expect(r.out).toContain("skipped parent-state");
    expect(r.out).toContain("fix:");
    expect(exitOf(r.result)).toBe(EXIT.SKIPPED);
  });

  test("no classes is a usage error with a runnable hint", async () => {
    const r = await run("explain");
    expect(codeOf(r.result)).toBe("E_NO_INPUT");
    expect(exitOf(r.result)).toBe(EXIT.USAGE);
    expect(isError(r.result) && r.result.hint).toContain("tw2sx explain");
  });

  test("classes split across several arguments are read as one set", async () => {
    const r = await run("explain flex p-4");
    const one = await run("explain flex,p-4".replace(",", " "));
    expect(r.out).toBe(one.out);
    expect(r.out).toContain("padding");
  });

  test("--json carries the style, the source and the entry css it used", async () => {
    const r = await run("explain flex --json");
    const body = record(json(r.out));
    expect(body.ok).toBe(true);
    expect(record(body.stylex).display).toBe("flex");
    expect(String(body.source)).toContain("stylex.create");
    expect(String(body.entry)).toContain("index.css");
    expect(body.skipped).toEqual([]);
  });

  test("--json on a skip reports ok false and a full skip record", async () => {
    const r = await run("explain group --json");
    const body = record(json(r.out));
    expect(body.ok).toBe(false);
    expect(body.stylex).toBeUndefined();
    const first = record(Array.isArray(body.skipped) ? body.skipped[0] : undefined);
    expect(first.reason).toBe("marker-class");
    expect(first.fix).toBe("safe");
    expect(first.file).toBe("<argv>");
  });
});

describe("plan writes a report and says where it went", () => {
  test("the report file is created at --out and is valid JSON", async () => {
    const out = path.join(dir, "r1.json");
    const r = await run(`plan ${dir}/src --out ${out}`);
    expect(fs.existsSync(out)).toBe(true);
    expect(record(json(fs.readFileSync(out, "utf8"))).tool).toBe("tw2sx");
    expect(r.out).toContain(`Full report: ${out}`);
  });

  test("skips mean exit 1, and the summary line leads", async () => {
    const r = await run(`plan ${dir}/src --out ${path.join(dir, "r2.json")}`);
    expect(r.out.split("\n")[0]).toContain("usages");
    expect(exitOf(r.result)).toBe(EXIT.SKIPPED);
  });

  test("a file with nothing to skip exits 0", async () => {
    const r = await run(`plan ${dir}/src/clean.tsx --out ${path.join(dir, "r3.json")}`);
    expect(r.out).toContain("MISMATCHES: 0");
    expect(exitOf(r.result)).toBe(EXIT.CLEAN);
  });

  test("without --out the report still lands somewhere predictable", async () => {
    const cwd = process.cwd();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-out-"));
    try {
      process.chdir(scratch);
      await run(`plan ${dir}/src/clean.tsx`);
      const written = fs.readdirSync(path.join(scratch, ".tw2sx"));
      expect(written.some(f => f.startsWith("plan-") && f.endsWith(".json"))).toBe(true);
    } finally {
      process.chdir(cwd);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a missing path is a usage error, named exactly", async () => {
    const r = await run(`plan ${dir}/does-not-exist`);
    expect(codeOf(r.result)).toBe("E_NO_SUCH_PATH");
    expect(exitOf(r.result)).toBe(EXIT.USAGE);
  });

  test("no path at all is a different error from a wrong path", async () => {
    const r = await run("plan");
    expect(codeOf(r.result)).toBe("E_NO_INPUT");
  });

  test("--json gives the summary plus per-file skips, and no source blobs", async () => {
    const r = await run(`plan ${dir}/src --out ${path.join(dir, "r4.json")} --json`);
    const body = record(json(r.out));
    const summary = record(body.summary);
    expect(summary.files).toBe(2);
    expect(Number(summary.usages)).toBeGreaterThan(0);
    expect(record(summary.byFix)).not.toEqual({});
    const first = record(Array.isArray(body.files) ? body.files[0] : undefined);
    expect(first.source).toBeUndefined();
    expect(Array.isArray(first.skips)).toBe(true);
  });

  test("--json=<fields> narrows the skip records to just those keys", async () => {
    const r = await run(`plan ${dir}/src --out ${path.join(dir, "r5.json")} --json=reason,fix`);
    const body = record(json(r.out));
    const files = Array.isArray(body.files) ? body.files : [];
    const skips = files.flatMap(f => (Array.isArray(record(f).skips) ? record(f).skips : []));
    const sample = record(Array.isArray(skips) ? skips[0] : undefined);
    expect(Object.keys(sample).sort()).toEqual(["fix", "reason"]);
  });
});

describe("skipped re-reads a report without redoing the work", () => {
  let report: string;

  beforeAll(async () => {
    report = path.join(dir, "skips.json");
    await run(`plan ${dir}/src --out ${report}`);
  });

  test("bare --json lists the fields you can ask for", async () => {
    const r = await run("skipped --json");
    expect(r.out.split("\n")).toEqual(SKIP_FIELDS);
    expect(exitOf(r.result)).toBe(EXIT.CLEAN);
  });

  test("--reason keeps only that reason", async () => {
    const r = await run(`skipped ${report} --reason marker-class`);
    const lines = r.out.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain("marker-class");
  });

  test("--fix keeps only that fix type", async () => {
    const r = await run(`skipped ${report} --fix needs-lookup --json=reason,fix`);
    const rows = json(r.out);
    expect(Array.isArray(rows) && rows.length).toBeGreaterThan(0);
    for (const row of Array.isArray(rows) ? rows : []) expect(record(row).fix).toBe("needs-lookup");
  });

  test("a filter that matches nothing exits 0 and prints nothing", async () => {
    const r = await run(`skipped ${report} --reason stylex-compile-error`);
    expect(r.out).toBe("");
    expect(exitOf(r.result)).toBe(EXIT.CLEAN);
  });

  test("--limit truncates and says what it truncated", async () => {
    const r = await run(`skipped ${report} --limit 1`);
    expect(r.out.split("\n").filter(l => l.startsWith(dir)).length).toBe(1);
    expect(r.out).toContain("Showing 1 of");
  });

  test("a missing report names the file and tells you how to make one", async () => {
    const r = await run(`skipped ${dir}/nope.json`);
    expect(codeOf(r.result)).toBe("E_NO_REPORT");
    expect(isError(r.result) && r.result.hint).toContain("tw2sx plan");
  });

  test("a JSON file that is not a report is a different error", async () => {
    const other = write("other.json", `{"hello":"world"}`);
    const r = await run(`skipped ${other}`);
    expect(codeOf(r.result)).toBe("E_BAD_REPORT");
    expect(exitOf(r.result)).toBe(EXIT.USAGE);
  });
});

describe("apply is a dry run until told otherwise", () => {
  test("without --write nothing on disk changes and the output says so", async () => {
    const file = write("src/dry.tsx", `export const A = () => <div className="flex" />;\n`);
    const before = fs.readFileSync(file, "utf8");
    const r = await run(`apply ${file}`);
    expect(r.out).toContain("DRY RUN");
    expect(r.out).toContain("Next: tw2sx apply");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("--json reports the counts and omits the file bodies", async () => {
    const file = write("src/dry2.tsx", `export const A = () => <div className="flex" />;\n`);
    const r = await run(`apply ${file} --json`);
    const body = record(json(r.out));
    expect(body.write).toBe(false);
    expect(record(body.summary).rewritten).toBe(1);
    const first = record(Array.isArray(body.files) ? body.files[0] : undefined);
    expect(first.diff).toBeUndefined();
  });

  test("a missing path fails the same way plan does", async () => {
    const r = await run(`apply ${dir}/nowhere`);
    expect(codeOf(r.result)).toBe("E_NO_SUCH_PATH");
  });

  test("exit 1 when anything was left for the user", async () => {
    const r = await run(`apply ${dir}/src`);
    expect(exitOf(r.result)).toBe(EXIT.SKIPPED);
  });
});

/**
 * Writing into a tree with uncommitted work interleaves the tool's edits with the user's, and
 * `git checkout` stops being an undo. The guard is the only thing standing between a bad run
 * and unrecoverable work, so it is checked from the command down.
 */
describe("apply --write refuses to run on a dirty tree", () => {
  let repo: string;
  let target: string;

  beforeAll(() => {
    // Inside the test directory so `tailwindcss` resolves; `git init` makes it its own repo.
    repo = fs.mkdtempSync(path.join(import.meta.dir, "tmp-git-"));
    fs.copyFileSync(path.join(import.meta.dir, "fixture.css"), path.join(repo, "index.css"));
    target = path.join(repo, "a.tsx");
    fs.writeFileSync(target, `export const A = () => <div className="flex" />;\n`);

    const git = (...a: string[]): void => {
      execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "init");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const runIn = async (line: string): Promise<CommandResult> => {
    const args = parseArgs([
      ...line.split(" ").filter(Boolean),
      "--css",
      path.join(repo, "index.css"),
    ]);
    const realLog = console.log;
    console.log = (): void => undefined;
    try {
      return await applyCommand(args, readOutput(args));
    } finally {
      console.log = realLog;
    }
  };

  test("a clean tree is written without complaint", async () => {
    const result = await runIn(`apply ${target} --write`);
    expect(isError(result)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toContain("stylex.props");
    execFileSync("git", ["checkout", "--", "."], { cwd: repo, stdio: "ignore" });
  });

  test("an uncommitted change blocks the write and names the files", async () => {
    fs.appendFileSync(target, "// edited\n");
    const result = await runIn(`apply ${target} --write`);
    expect(codeOf(result)).toBe("E_DIRTY_TREE");
    expect(exitOf(result)).toBe(EXIT.PRECONDITION);
    expect(isError(result) && result.message).toContain("a.tsx");
  });

  test("the hint says how to proceed and what it costs", async () => {
    const result = await runIn(`apply ${target} --write`);
    expect(isError(result) && result.hint).toContain("--allow-dirty");
    expect(isError(result) && result.hint).toContain("hard to revert");
  });

  test("the blocked run wrote nothing", async () => {
    expect(fs.readFileSync(target, "utf8")).not.toContain("stylex.props");
  });

  test("a dry run is never blocked, because it cannot lose anything", async () => {
    const result = await runIn(`apply ${target}`);
    expect(isError(result)).toBe(false);
  });

  test("--allow-dirty is the way through", async () => {
    const result = await runIn(`apply ${target} --write --allow-dirty`);
    expect(isError(result)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toContain("stylex.props");
  });
});

describe("entry css discovery fails loudly rather than guessing", () => {
  test("no Tailwind entry anywhere up the tree is a precondition error", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-bare-"));
    try {
      fs.writeFileSync(
        path.join(bare, "a.tsx"),
        `export const A = () => <div className="flex" />;`,
      );
      const args = parseArgs(["plan", path.join(bare, "a.tsx")]);
      const result = await planCommand(args, readOutput(args));
      expect(codeOf(result)).toBe("E_NO_ENTRY_CSS");
      expect(exitOf(result)).toBe(EXIT.PRECONDITION);
      expect(isError(result) && result.hint).toContain("--css");
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("exit codes mean one thing each", () => {
  test.each([
    [EXIT.CLEAN, 0],
    [EXIT.SKIPPED, 1],
    [EXIT.USAGE, 2],
    [EXIT.PRECONDITION, 3],
    [EXIT.INTERNAL, 10],
  ])("%p is %p and does not move", (actual, expected) => {
    expect(actual).toBe(expected);
  });

  // A Report carries its own `ok` field; discriminating on that classified good reports as
  // failures. The discriminator is `code`.
  test("a successful result is never mistaken for a failure", () => {
    expect(isError({ exit: 0 })).toBe(false);
    expect(isError({ ok: true, exit: 1 })).toBe(false);
    expect(isError({ ok: false, code: "E_X", exit_code: 2, message: "m", hint: "h" })).toBe(true);
  });
});
