import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectFiles, findEntryCss } from "../src/find-files.ts";

const made: string[] = [];

const workspace = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-files-"));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TW = `@import "tailwindcss";\n`;

describe("finding the entry CSS", () => {
  test.each([
    "src/index.css",
    "src/app.css",
    "src/styles/globals.css",
    "app/globals.css",
    "styles/globals.css",
    "index.css",
  ])("%s is one of the places we look", rel => {
    const dir = workspace({ [rel]: TW });
    expect(findEntryCss(dir)).toBe(path.join(dir, rel));
  });

  // The @import is the whole test: a stylesheet that is not Tailwind's entry would load an
  // empty design system, and every class in the project would come back unknown-class.
  test("a CSS file in the right place without the Tailwind import is not the entry", () => {
    const dir = workspace({ "src/index.css": ".a { color: red }\n" });
    expect(findEntryCss(dir)).toBeUndefined();
  });

  test.each([
    `@import "tailwindcss";`,
    `@import 'tailwindcss';`,
    `@import "tailwindcss/theme.css";`,
  ])("%s counts as the import", line => {
    const dir = workspace({ "src/index.css": line });
    expect(findEntryCss(dir)).toBeDefined();
  });

  test("the search walks up from a nested directory", () => {
    const dir = workspace({ "src/index.css": TW, "src/components/ui/button.tsx": "" });
    expect(findEntryCss(path.join(dir, "src/components/ui"))).toBe(path.join(dir, "src/index.css"));
  });

  test("nothing anywhere is undefined, not a throw", () => {
    expect(findEntryCss(workspace({ "a.tsx": "" }))).toBeUndefined();
  });
});

describe("collecting source files", () => {
  test("a file target is just that file, whatever its extension", () => {
    const dir = workspace({ "a.tsx": "", "b.tsx": "" });
    expect(collectFiles(path.join(dir, "a.tsx"))).toEqual([path.join(dir, "a.tsx")]);
  });

  test.each(["a.tsx", "b.jsx", "c.ts", "d.js"])("%s is collected", name => {
    const dir = workspace({ [name]: "" });
    expect(collectFiles(dir)).toEqual([path.join(dir, name)]);
  });

  test.each(["a.css", "b.json", "c.md", "d.d.ts", "e.snap"])("%s is not", name => {
    const dir = workspace({ [name]: "" });
    expect(collectFiles(dir)).toEqual([]);
  });

  test("node_modules is never descended into", () => {
    const dir = workspace({ "a.tsx": "", "node_modules/pkg/index.js": "" });
    expect(collectFiles(dir)).toEqual([path.join(dir, "a.tsx")]);
  });

  test("dot directories are skipped, so .next and .git cost nothing", () => {
    const dir = workspace({ "a.tsx": "", ".next/page.js": "", ".git/hooks/x.js": "" });
    expect(collectFiles(dir)).toEqual([path.join(dir, "a.tsx")]);
  });

  test("dotfiles themselves are skipped too", () => {
    const dir = workspace({ "a.tsx": "", ".eslintrc.js": "" });
    expect(collectFiles(dir)).toEqual([path.join(dir, "a.tsx")]);
  });

  test("nesting is followed to the bottom", () => {
    const dir = workspace({ "a/b/c/deep.tsx": "" });
    expect(collectFiles(dir)).toEqual([path.join(dir, "a/b/c/deep.tsx")]);
  });

  test("an empty directory yields an empty list", () => {
    expect(collectFiles(workspace({}))).toEqual([]);
  });

  // The report path is a hash of this list, so a run over the same tree must reuse the report.
  test("the order is stable across runs", () => {
    const dir = workspace({ "b.tsx": "", "a.tsx": "", "z/y.tsx": "" });
    expect(collectFiles(dir)).toEqual(collectFiles(dir));
  });
});
