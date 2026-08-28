import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { scanFile } from "../src/scan-file.ts";
import { DEFAULT_FIX, FIX_MEANING, FIXES, REASONS, type Reason } from "../src/skip.ts";

const repo = path.join(import.meta.dir, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8");

/**
 * The reason list is fixed so an agent can branch on it, and the skill promises one how-to-fix
 * section per reason. That promise used to be kept by hand, and had already drifted: `cva-call`
 * had a section and no producer.
 */
describe("the skill documents exactly the reasons that exist", () => {
  const docs = new Set(
    [...read("skill/references/reason-codes.md").matchAll(/^## `([a-z-]+)`/gm)].map(m => m[1]),
  );

  test("every reason has a section", () => {
    expect(REASONS.filter(r => !docs.has(r))).toEqual([]);
  });

  test("no section documents a reason that does not exist", () => {
    const known = new Set<string>(REASONS);
    expect([...docs].filter(d => d !== undefined && !known.has(d))).toEqual([]);
  });

  test("each section's heading states the same fix as the code", () => {
    const doc = read("skill/references/reason-codes.md");
    for (const [, reason, stated] of doc.matchAll(/^## `([a-z-]+)` — ([a-z-]+)/gm)) {
      if (reason === undefined || stated === undefined) continue;
      expect(stated).toBe(DEFAULT_FIX[reason as Reason]);
    }
  });
});

describe("every reason can actually happen", () => {
  const sources = fs
    .readdirSync(path.join(repo, "src"))
    .filter(f => f.endsWith(".ts"))
    .map(f => read(path.join("src", f)))
    .join("\n");

  // A reason nobody constructs is a code an agent can branch on and never see.
  test.each([...REASONS])("%s is produced somewhere in src/", reason => {
    expect(sources).toContain(`"${reason}"`);
  });
});

describe("fix types", () => {
  test("every fix has a one-line meaning for --help", () => {
    for (const fix of FIXES) expect(FIX_MEANING[fix].length).toBeGreaterThan(10);
  });

  test("no reason maps to a fix that does not exist", () => {
    for (const reason of REASONS) expect(FIXES).toContain(DEFAULT_FIX[reason]);
  });
});

describe("variant-function fires on the cva naming convention", () => {
  test("buttonVariants() is named precisely, not lumped into dynamic-classes", () => {
    const src = `export const B = () => <button className={cn(buttonVariants({ size: "sm" }))} />;`;
    const reasons = scanFile(src, "b.tsx").usages.flatMap(u => u.skips.map(s => s.reason));
    expect(reasons).toContain("variant-function");
  });

  test("an unrecognised call is still dynamic-classes", () => {
    const src = `export const B = () => <button className={cn(somethingElse())} />;`;
    const reasons = scanFile(src, "b.tsx").usages.flatMap(u => u.skips.map(s => s.reason));
    expect(reasons).toContain("dynamic-classes");
  });
});

describe("every reference the skill points at exists", () => {
  const skill = read("skill/SKILL.md");
  const pointedAt = [...skill.matchAll(/\]\(references\/([a-z-]+\.md)\)/g)].map(m => m[1] ?? "");

  test.each([...new Set(pointedAt)])("references/%s is there", file => {
    expect(fs.existsSync(path.join(repo, "skill/references", file))).toBe(true);
  });

  test("no reference file is orphaned", () => {
    const onDisk = fs.readdirSync(path.join(repo, "skill/references"));
    expect(onDisk.filter(f => !pointedAt.includes(f))).toEqual([]);
  });
});
