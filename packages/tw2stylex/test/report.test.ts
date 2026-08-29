import { describe, expect, test } from "bun:test";

import type { Mismatch } from "../src/check.ts";
import {
  renderReport,
  toSkipLine,
  type FileResult,
  type Report,
  type SkipLine,
} from "../src/report.ts";
import type { Fix, Reason, Skip } from "../src/skip.ts";

const skip = (reason: Reason, extra: Partial<Skip> = {}): Skip => ({
  reason,
  detail: `detail for ${reason}`,
  hint: `hint for ${reason}`,
  ...extra,
});

const line = (reason: Reason, extra: Partial<Skip> = {}): SkipLine =>
  toSkipLine("src/a.tsx", 3, 7, skip(reason, extra));

const mismatch = (property: string): Mismatch => ({
  styleName: "el1",
  condition: ":hover",
  property,
  tailwind: "red",
  stylex: undefined,
});

const file = (over: Partial<FileResult> = {}): FileResult => ({
  file: "src/a.tsx",
  verdict: "partial",
  usages: 2,
  converted: 1,
  skipped: 1,
  skips: [],
  mismatches: [],
  ...over,
});

const report = (files: FileResult[], over: Partial<Report["summary"]> = {}): Report => ({
  ok: files.every(f => f.mismatches.length === 0),
  tool: "tw2sx",
  tailwind: "4.3.3",
  entry: "/p/src/index.css",
  summary: {
    files: files.length,
    usages: 10,
    converted: 7,
    skipped: 3,
    byReason: {},
    byFix: {},
    ...over,
  },
  files,
});

describe("a skip line is paste-ready on its own", () => {
  test("it starts with a file:line:column an editor can jump to", () => {
    expect(line("parent-state").message.startsWith("src/a.tsx:3:7:")).toBe(true);
  });

  test("it names the reason, the class and what to do", () => {
    const l = line("descendant-selector", { class: "[&_svg]:size-4" });
    expect(l.message).toContain("descendant-selector");
    expect(l.message).toContain(`"[&_svg]:size-4"`);
    expect(l.message).toContain("fix: hint for descendant-selector");
  });

  test("a skip with no class to blame does not print an empty pair of quotes", () => {
    expect(line("dynamic-classes").message).not.toContain('""');
  });

  test("the structured fields carry the same content as the message", () => {
    const l = line("marker-class", { class: "group" });
    expect(l).toMatchObject({ file: "src/a.tsx", line: 3, column: 7, reason: "marker-class" });
    expect(l.message).toContain(l.detail);
    expect(l.message).toContain(l.hint);
  });
});

describe("the fix comes from the skip, never from re-deriving it", () => {
  test("a reason's default is used when the skip does not override it", () => {
    expect(line("marker-class").fix).toBe("safe");
    expect(line("parent-state").fix).toBe("needs-lookup");
  });

  // The bug this pins: the breakdown recomputed the fix from the reason and dropped the
  // override, so the table and the `Next:` line one row below it disagreed.
  test("an override survives into the table and the Next line together", () => {
    const overridden = line("marker-class", { fix: "check-first" });
    expect(overridden.fix).toBe("check-first");

    const out = renderReport(report([file({ skips: [overridden] })]), 20, "r.json");
    const table = out.slice(out.indexOf("in the order to work them"));
    // Listed under check-first, not under marker-class's default of safe.
    expect(/check-first\n\s+marker-class/.test(table)).toBe(true);
    expect(out).toContain("--fix check-first");
  });
});

describe("the first line survives truncation", () => {
  test("it carries every count before anything else", () => {
    const out = renderReport(report([file()]), 20);
    expect(out.split("\n")[0]).toBe("1 files · 10 usages · 7 converted · 3 skipped");
  });
});

describe("mismatches are a hard stop and print first", () => {
  test("zero mismatches say so plainly with no alarm", () => {
    const out = renderReport(report([file()]), 20);
    expect(out).toContain("MISMATCHES: 0");
    expect(out).not.toContain("STOP");
  });

  test("any mismatch says STOP and blames the tool, not the user", () => {
    const out = renderReport(report([file({ mismatches: [mismatch("color")] })]), 20);
    expect(out).toContain("MISMATCHES: 1");
    expect(out).toContain("STOP");
    expect(out).toContain("tw2sx bug");
  });

  test("the mismatch line names the style, condition, property and both values", () => {
    const out = renderReport(report([file({ mismatches: [mismatch("color")] })]), 20);
    expect(out).toContain("el1 [:hover] color: tailwind=red stylex=(none)");
  });

  test("mismatches print above the skips", () => {
    const out = renderReport(
      report([file({ mismatches: [mismatch("color")], skips: [line("marker-class")] })]),
      20,
    );
    expect(out.indexOf("MISMATCHES")).toBeLessThan(out.indexOf("marker-class"));
  });
});

describe("skips are grouped in the order they should be worked", () => {
  const mixed = report([
    file({
      skips: [
        line("unknown-class"),
        line("passed-in-classes"),
        line("parent-state"),
        line("marker-class"),
      ],
    }),
  ]);

  test("safe, then needs-lookup, then check-first, then unknown", () => {
    const out = renderReport(mixed, 20);
    const table = out.slice(out.indexOf("in the order to work them"));
    const order = (["safe", "needs-lookup", "check-first", "unknown"] as Fix[]).map(f =>
      table.indexOf(`  ${f}`),
    );
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("Next points at the first bucket with work in it", () => {
    expect(renderReport(mixed, 20, "r.json")).toContain("tw2sx skipped r.json --fix safe");
  });

  test("with nothing safe left, Next moves down the order", () => {
    const out = renderReport(report([file({ skips: [line("passed-in-classes")] })]), 20, "r.json");
    expect(out).toContain("--fix check-first");
  });

  test("a bucket with no skips is not printed as an empty heading", () => {
    const out = renderReport(report([file({ skips: [line("marker-class")] })]), 20);
    expect(out).toContain("  safe");
    expect(out).not.toContain("  unknown");
  });

  test("within a bucket the biggest pile comes first", () => {
    const out = renderReport(
      report([
        file({
          skips: [
            line("parent-state"),
            line("sibling-state", { class: "a" }),
            line("sibling-state", { class: "b" }),
          ],
        }),
      ]),
      20,
    );
    const table = out.slice(out.indexOf("needs-lookup"));
    expect(table.indexOf("sibling-state")).toBeLessThan(table.indexOf("parent-state"));
  });
});

describe("the limit bounds the output without hiding the total", () => {
  const many = report([
    file({ skips: Array.from({ length: 50 }, (_, i) => line("marker-class", { class: `g${i}` })) }),
  ]);

  test("only `limit` lines print, and the total is still stated", () => {
    const out = renderReport(many, 5);
    expect(out.split("\n").filter(l => l.includes("skipped marker-class"))).toHaveLength(5);
    expect(out).toContain("Showing 5 of 50 skipped classes.");
  });

  test("limit 0 leaves the summary and the counts", () => {
    const out = renderReport(many, 0);
    expect(out).not.toContain("skipped marker-class");
    expect(out).toContain("marker-class");
    expect(out).toContain("MISMATCHES: 0");
  });

  test("under the limit there is no truncation notice", () => {
    expect(renderReport(report([file({ skips: [line("marker-class")] })]), 20)).not.toContain(
      "Showing",
    );
  });
});

describe("degenerate reports render instead of throwing", () => {
  test("no files at all", () => {
    const out = renderReport(report([], { files: 0, usages: 0, converted: 0, skipped: 0 }), 20);
    expect(out).toContain("0 files");
    expect(out).toContain("MISMATCHES: 0");
  });

  test("nothing skipped means no breakdown and no Next", () => {
    const out = renderReport(report([file({ skips: [] })]), 20, "r.json");
    expect(out).not.toContain("in the order to work them");
    expect(out).not.toContain("Next:");
    expect(out).toContain("Full report: r.json");
  });

  test("without a report path there is nowhere to point, so neither line appears", () => {
    const out = renderReport(report([file({ skips: [line("marker-class")] })]), 20);
    expect(out).not.toContain("Full report");
    expect(out).not.toContain("Next:");
  });
});
