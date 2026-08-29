import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EXIT } from "../src/fail.ts";
import { FIXES, REASONS } from "../src/skip.ts";

const repo = path.join(import.meta.dir, "..");
const cli = path.join(repo, "src/cli.ts");
const css = path.join(repo, "test/fixture.css");

type Run = { code: number; out: string; err: string };

const runWith = (runtime: string, args: string[]): Run => {
  const r = spawnSync(runtime, [cli, ...args], { cwd: repo, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};

const run = (...args: string[]): Run => runWith("bun", args);

describe("the CLI tells you how to use it before you get anything wrong", () => {
  test("help exits clean and lists every command", () => {
    const r = run("help");
    expect(r.code).toBe(EXIT.NOTHING_SKIPPED);
    for (const c of ["explain", "plan", "skipped", "apply"]) expect(r.out).toContain(`tw2sx ${c}`);
  });

  test("no arguments prints the same help but exits 2, so a script notices", () => {
    const r = run();
    expect(r.code).toBe(EXIT.BAD_ARGUMENTS);
    expect(r.out).toContain("COMMANDS");
  });

  test("--help works on any command", () => {
    expect(run("plan", "--help").code).toBe(EXIT.NOTHING_SKIPPED);
  });

  test("an unknown command names itself and points at help", () => {
    const r = run("planx", "src");
    expect(r.code).toBe(EXIT.BAD_ARGUMENTS);
    expect(r.err).toContain("Unknown command: planx");
    expect(r.err).toContain("E_UNKNOWN_COMMAND");
  });

  // The help is the only place an agent learns the vocabulary, so it has to be complete.
  test("every reason code appears in the help", () => {
    const help = run("help").out;
    for (const reason of REASONS) expect(help).toContain(reason);
  });

  test("every fix type appears in the help with its meaning", () => {
    const help = run("help").out;
    for (const fix of FIXES) expect(help).toContain(fix);
  });

  test("the help says plainly that nothing is written without --write", () => {
    expect(run("help").out).toContain("nothing writes unless you say --write");
  });
});

describe("exit codes are what a script should branch on", () => {
  test.each([
    [["explain", "flex p-4", "--css", css], EXIT.NOTHING_SKIPPED],
    [["explain", "dark:text-white", "--css", css], EXIT.SOME_SKIPPED],
    [["explain", "--css", css], EXIT.BAD_ARGUMENTS],
    [["plan", "/no/such/path", "--css", css], EXIT.BAD_ARGUMENTS],
  ])("%p exits %p", (args, expected) => {
    expect(run(...args).code).toBe(expected);
  });

  // `skipped --json` with no value is the `gh` pattern: it lists the field names and never
  // looks at the report. Pinned because it makes `--json` mean something different here than
  // it does on plan and apply.
  test("bare --json on skipped lists fields instead of reading the report", () => {
    const r = run("skipped", "/no/such/report.json", "--json");
    expect(r.code).toBe(EXIT.NOTHING_SKIPPED);
    expect(r.out.split("\n")).toContain("reason");
  });

  test("a failure prints its envelope to stderr, leaving stdout parseable", () => {
    const r = run("skipped", "/no/such/report.json", "--json=reason");
    expect(r.out).toBe("");
    const body: unknown = JSON.parse(r.err);
    expect(body).toMatchObject({ ok: false, code: "E_NO_REPORT", exit_code: EXIT.BAD_ARGUMENTS });
  });

  test("without --json a failure is still readable prose with a code and a hint", () => {
    const r = run("skipped", "/no/such/report.json");
    expect(r.err).toContain("tw2sx: Report not found");
    expect(r.err).toContain("hint: Run tw2sx plan");
    expect(r.err).toContain("code: E_NO_REPORT");
  });
});

// The agent reads stdout every run, so stdout is where the pointer to the skill has to live.
describe("plan points at the skill", () => {
  const planIn = (dir: string): string => {
    fs.writeFileSync(path.join(dir, "a.tsx"), `export const A = () => <div className="flex" />;\n`);
    const r = spawnSync("bun", [cli, "plan", ".", "--limit", "0", "--css", css], {
      cwd: dir,
      encoding: "utf8",
    });
    return r.stdout;
  };

  test("at init when the skill is not installed yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-noskill-"));
    try {
      expect(planIn(dir)).toContain("Skill: run tw2sx init");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("at the installed SKILL.md once it is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-skill-"));
    try {
      fs.mkdirSync(path.join(dir, ".agents"));
      spawnSync("bun", [cli, "init"], { cwd: dir });
      expect(planIn(dir)).toContain(
        "read .agents/skills/migrating-tailwind-to-stylex/SKILL.md in full",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The published binary runs under Node, the tests run under Bun, and the two disagree about
 * CommonJS. That gap once shipped a build where every command threw on the first `require`.
 */
describe("the CLI works under Node, not only under Bun", () => {
  test("explain produces the same output under both runtimes", () => {
    const args = ["explain", "flex items-center p-4", "--css", css];
    const bun = runWith("bun", args);
    const node = runWith("node", args);
    expect(node.code).toBe(bun.code);
    expect(node.out).toBe(bun.out);
  });

  test("loading the Tailwind design system works under Node", () => {
    const r = runWith("node", ["explain", "bg-brand", "--css", css, "--json"]);
    expect(r.code).toBe(EXIT.NOTHING_SKIPPED);
    const body: unknown = JSON.parse(r.out);
    expect(body).toMatchObject({ ok: true, stylex: { backgroundColor: "var(--color-brand)" } });
  });
});
