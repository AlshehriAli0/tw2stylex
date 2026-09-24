import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { applyFile } from "../src/apply.ts";
import { convert } from "../src/convert.ts";
import { processFile } from "../src/plan.ts";
import { loadDesignSystem, type LoadedSystem } from "../src/tailwind.ts";
import { loadTokens, tokenSkips } from "../src/tokens.ts";

let dir: string;
let sys: LoadedSystem;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(import.meta.dir, "tmp-tokens-"));
  fs.copyFileSync(path.join(import.meta.dir, "fixture.css"), path.join(dir, "index.css"));
  fs.writeFileSync(
    path.join(dir, "theme.stylex.ts"),
    `import * as stylex from '@stylexjs/stylex';\nexport const colors = stylex.defineConsts({ primary: "rgb(var(--primary))" } satisfies Record<string, string>);\nexport const radii = stylex.defineConsts({ full: "9999px" });\n`,
  );
  fs.writeFileSync(
    path.join(dir, "tokens.json"),
    JSON.stringify({
      "rgb(var(--primary))": { from: "./theme.stylex.ts", export: "colors", key: "primary" },
      "calc(infinity * 1px)": { from: "./theme.stylex.ts", export: "radii", key: "full" },
    }),
  );
  sys = await loadDesignSystem(path.join(dir, "index.css"));
  sys.tokens = loadTokens(path.join(dir, "tokens.json"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("an exact defineConsts value gets an import and preserves the checked CSS", () => {
  const file = path.join(dir, "button.tsx");
  fs.writeFileSync(file, `export const Button = () => <button className="bg-primary" />;\n`);
  const converted = convert(sys.ds, "button", ["bg-primary"]);
  expect(converted.style?.backgroundColor).toBe("rgb(var(--primary))");
  expect(converted.mismatches).toEqual([]);
  const preview = applyFile(sys, file, false);
  expect(preview.diff).toContain('import * as tw2stylexToken1 from "./theme.stylex";');
  expect(preview.diff).toContain("backgroundColor: tw2stylexToken1.colors.primary");
  expect(fs.readFileSync(file, "utf8")).toContain('className="bg-primary"');
  applyFile(sys, file, true);
  expect(fs.readFileSync(file, "utf8")).toBe(preview.diff);
});

test("a different token value cannot pass as an exact declaration", () => {
  const converted = convert(sys.ds, "radius", ["rounded-full"]);
  expect(converted.style?.borderRadius).toBe("calc(infinity * 1px)");
  expect(tokenSkips(converted.style ?? {}, sys.tokens).map(s => s.reason)).toEqual([
    "token-needs-verification",
  ]);
  const file = path.join(dir, "full.tsx");
  fs.writeFileSync(file, `export const A = () => <div className="rounded-full" />;\n`);
  const result = applyFile(sys, file, false);
  expect(result.rewritten).toBe(0);
  expect(result.skipped).toBe(1);
  expect(processFile(sys, file).skips.map(skip => skip.reason)).toContain(
    "token-needs-verification",
  );
});
