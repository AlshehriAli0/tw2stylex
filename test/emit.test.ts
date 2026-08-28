import { describe, expect, test } from "bun:test";

import { canonicalPath, printCreate, toNamespace, type SxNamespace } from "../src/emit.ts";
import type { CondPath, Resolved } from "../src/reshape.ts";

/** Build a Resolved by hand so these tests need no Tailwind design system. */
const resolved = (groups: Array<[CondPath, Record<string, string>]>): Resolved => {
  const decls: Resolved["decls"] = new Map();
  for (const [path, props] of groups) {
    decls.set(path.join(" "), { path, props: new Map(Object.entries(props)) });
  }
  return { decls, refusals: [] };
};

const ns = (groups: Array<[CondPath, Record<string, string>]>): SxNamespace =>
  toNamespace(resolved(groups));

describe("canonicalPath", () => {
  test("an unconditioned path stays empty", () => {
    expect(canonicalPath([])).toEqual([]);
  });

  test("selector fragments collapse into one compound key", () => {
    expect(canonicalPath(["[data-disabled]", "[data-checked]", ":hover"])).toEqual([
      "[data-disabled][data-checked]:hover",
    ]);
  });

  test("at-rules stay nested after the selector", () => {
    expect(canonicalPath([":hover", "@media (hover: hover)"])).toEqual([
      ":hover",
      "@media (hover: hover)",
    ]);
  });

  test("an at-rule with no selector needs no compound key", () => {
    expect(canonicalPath(["@media (width >= 48rem)"])).toEqual(["@media (width >= 48rem)"]);
  });

  test("selector order is preserved, since :not(x):hover differs from :hover:not(x) textually", () => {
    expect(canonicalPath([":active", ":not([disabled])"])).toEqual([":active:not([disabled])"]);
  });
});

describe("toNamespace", () => {
  test("an unconditioned declaration is a bare value", () => {
    expect(ns([[[], { display: "flex" }]])).toEqual({ display: "flex" });
  });

  test("a purely numeric value becomes a number", () => {
    expect(ns([[[], { flexShrink: "0", opacity: "0.5", zIndex: "10" }]])).toEqual({
      flexShrink: 0,
      opacity: 0.5,
      zIndex: 10,
    });
  });

  test("a value with units stays a string", () => {
    expect(ns([[[], { padding: "4px", width: "50%", height: "1.5rem" }]])).toEqual({
      padding: "4px",
      width: "50%",
      height: "1.5rem",
    });
  });

  test("a negative number is still a number", () => {
    expect(ns([[[], { order: "-1" }]])).toEqual({ order: -1 });
  });

  test("a conditional-only property gets a null default", () => {
    expect(ns([[[":hover"], { color: "red" }]])).toEqual({
      color: { default: null, ":hover": "red" },
    });
  });

  test("a base value becomes the default alongside its conditions", () => {
    expect(
      ns([
        [[], { color: "black" }],
        [[":hover"], { color: "red" }],
      ]),
    ).toEqual({ color: { default: "black", ":hover": "red" } });
  });

  test("several conditions on one property all survive", () => {
    const out = ns([
      [[], { display: "block" }],
      [["@media (width >= 40rem)"], { display: "flex" }],
      [["@media (width >= 64rem)"], { display: "grid" }],
    ]);
    expect(out.display).toEqual({
      default: "block",
      "@media (width >= 40rem)": "flex",
      "@media (width >= 64rem)": "grid",
    });
  });

  test("a nested at-rule under a selector nests one level", () => {
    expect(ns([[[":hover", "@media (hover: hover)"], { color: "red" }]])).toEqual({
      color: { default: null, ":hover": { default: null, "@media (hover: hover)": "red" } },
    });
  });

  // The bug: a scalar written at [x] was clobbered when [x, y] arrived afterwards.
  test("a scalar condition survives a deeper condition on the same key", () => {
    const out = ns([
      [["[data-checked]"], { color: "blue" }],
      [["[data-checked]", "@media (hover: hover)"], { color: "green" }],
    ]);
    expect(out.color).toEqual({
      default: null,
      "[data-checked]": { default: "blue", "@media (hover: hover)": "green" },
    });
  });

  test("a deeper condition arriving first still keeps the later scalar", () => {
    const out = ns([
      [["[data-checked]", "@media (hover: hover)"], { color: "green" }],
      [["[data-checked]"], { color: "blue" }],
    ]);
    expect(out.color).toEqual({
      default: null,
      "[data-checked]": { default: "blue", "@media (hover: hover)": "green" },
    });
  });

  test("independent properties do not interfere", () => {
    const out = ns([
      [[], { color: "black", display: "flex" }],
      [[":hover"], { color: "red" }],
    ]);
    expect(out.display).toBe("flex");
    expect(out.color).toEqual({ default: "black", ":hover": "red" });
  });
});

describe("printCreate", () => {
  test("names the variable and each namespace", () => {
    const src = printCreate({ card: { display: "flex" } });
    expect(src).toContain("const styles = stylex.create({");
    expect(src).toContain("card: {");
    expect(src).toContain('display: "flex",');
  });

  test("honours a custom variable name", () => {
    expect(printCreate({ a: { display: "flex" } }, "variants")).toContain("const variants =");
  });

  test("quotes keys that are not identifiers", () => {
    const src = printCreate({ a: { color: { default: null, ":hover": "red" } } });
    expect(src).toContain('":hover": "red"');
    expect(src).toContain("default: null");
  });

  test("quotes a namespace name that is not an identifier", () => {
    expect(printCreate({ "row-action": { display: "flex" } })).toContain('"row-action": {');
  });

  test("emits numbers unquoted and strings quoted", () => {
    const src = printCreate({ a: { flexShrink: 0, padding: "4px" } });
    expect(src).toContain("flexShrink: 0,");
    expect(src).toContain('padding: "4px",');
  });

  test("round-trips a deeply nested condition", () => {
    const src = printCreate({
      a: { color: { default: null, ":hover": { default: null, "@media (hover: hover)": "red" } } },
    });
    expect(src).toContain('"@media (hover: hover)": "red"');
  });
});
