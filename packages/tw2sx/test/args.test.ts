import { describe, expect, test } from "bun:test";

import {
  flagWithoutValue,
  flagNumber,
  flagWasPassed,
  flagString,
  parseArgs,
  positionalAt,
} from "../src/args.ts";

const parse = (line: string) => parseArgs(line.split(" ").filter(Boolean));

describe("flags can be written either way", () => {
  test("--name=value and --name value mean the same thing", () => {
    for (const line of ["plan src --css a.css", "plan src --css=a.css"])
      expect(flagString(parse(line), "css")).toBe("a.css");
  });

  test("a bare --name is true, not a string", () => {
    const args = parse("apply src --write");
    expect(flagWithoutValue(args, "write")).toBe(true);
    expect(flagString(args, "write")).toBeUndefined();
  });

  test("a flag before another flag stays bare", () => {
    // --json must not swallow --limit as its value.
    const args = parse("plan src --json --limit 5");
    expect(flagWithoutValue(args, "json")).toBe(true);
    expect(flagNumber(args, "limit", 20)).toBe(5);
  });

  test("--name= is an empty string, which is still a value", () => {
    const args = parse("plan src --json=");
    expect(flagString(args, "json")).toBe("");
    expect(flagWithoutValue(args, "json")).toBe(false);
    expect(flagWasPassed(args, "json")).toBe(true);
  });

  test("a value containing = keeps everything after the first one", () => {
    expect(flagString(parse("plan src --out=a=b.json"), "out")).toBe("a=b.json");
  });

  test("the last of a repeated flag wins", () => {
    expect(flagString(parse("plan src --css a.css --css b.css"), "css")).toBe("b.css");
  });
});

describe("positionals keep their order and are not confused with flags", () => {
  test("the command is positional 0 and the target positional 1", () => {
    const args = parse("plan src/ui --write");
    expect(positionalAt(args, 0)).toBe("plan");
    expect(positionalAt(args, 1)).toBe("src/ui");
    expect(positionalAt(args, 2)).toBeUndefined();
  });

  test("a flag between positionals does not reorder them", () => {
    const args = parse("skipped --limit 5 report.json");
    expect(positionalAt(args, 0)).toBe("skipped");
    expect(positionalAt(args, 1)).toBe("report.json");
  });

  test("class strings survive as positionals, dashes and all", () => {
    const args = parseArgs(["explain", "flex p-4 hover:bg-accent"]);
    expect(positionalAt(args, 1)).toBe("flex p-4 hover:bg-accent");
  });

  test("a lone dash is a positional, not a flag", () => {
    expect(positionalAt(parse("plan -"), 1)).toBe("-");
  });
});

describe("flagNumber falls back rather than producing NaN", () => {
  test.each([
    ["--limit 5", 5],
    ["--limit 0", 0],
    ["--limit=0", 0],
    ["--limit abc", 20],
    ["--limit", 20],
    ["", 20],
  ])("%s reads as %p", (line, expected) => {
    expect(flagNumber(parse(`plan src ${line}`), "limit", 20)).toBe(expected);
  });

  // Guarding this specifically: `--limit 0` means "summary only" and a falsy check would
  // silently turn it back into the default.
  test("zero is a real limit, not a missing one", () => {
    expect(flagNumber(parse("plan src --limit 0"), "limit", 20)).toBe(0);
  });
});

describe("flagWasPassed and flagWithoutValue answer different questions", () => {
  test.each([
    ["--allow-dirty", true, true],
    ["--allow-dirty=false", true, false],
    ["", false, false],
  ])("%s -> present %p, bare %p", (line, present, bare) => {
    const args = parse(`apply src ${line}`);
    expect(flagWasPassed(args, "allow-dirty")).toBe(present);
    expect(flagWithoutValue(args, "allow-dirty")).toBe(bare);
  });
});
