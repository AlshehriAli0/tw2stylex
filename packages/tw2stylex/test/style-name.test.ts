import { describe, expect, test } from "bun:test";

import type { Usage, UsageKind } from "../src/scan-file.ts";
import { nameIsTaken, styleNameFor, styleObjectName } from "../src/style-name.ts";

const usage = (kind: UsageKind, over: Partial<Usage> = {}): Usage => ({
  classNames: ["flex"],
  loc: { line: 1, column: 1 },
  kind,
  skips: [],
  ...over,
});

const name = (u: Usage, index = 0, used = new Set<string>()): string =>
  styleNameFor(u, index, used);

describe("a style is named after where it came from", () => {
  test("a cva base is called base", () => {
    expect(name(usage("cva-base"))).toBe("base");
  });

  test("a cva variant is named for its axis and value", () => {
    expect(name(usage("cva-variant", { variantAxis: "size", variantValue: "sm" }))).toBe("sizeSm");
  });

  test.each([
    ["size", "lg", "sizeLg"],
    ["variant", "destructive", "variantDestructive"],
    ["variant", "outline-ghost", "variantOutlineGhost"],
    ["intent", "primary_bold", "intentPrimaryBold"],
    ["state", "2xl", "state2xl"],
  ])("%s/%s becomes %s", (axis, value, expected) => {
    expect(name(usage("cva-variant", { variantAxis: axis, variantValue: value }))).toBe(expected);
  });

  test.each([
    ["billing", "billing"],
    ["Save billing", "saveBilling"],
    ["h2", "h2"],
    ["my-element", "myElement"],
    ["Card", "card"],
    ["Foo.Bar", "fooBar"],
  ])("a JSX usage on an element called %p is %s", (elementName, expected) => {
    expect(name(usage("literal", { elementName }))).toBe(expected);
    expect(name(usage("cn-call", { elementName }))).toBe(expected);
  });

  test.each([
    ["literal" as const, 0, "el1"],
    ["literal" as const, 4, "el5"],
    ["cn-call" as const, 1, "el2"],
  ])("a plain %s with no element name at index %p is %s", (kind, index, expected) => {
    expect(name(usage(kind), index)).toBe(expected);
  });

  test.each(["", "2col", "---", "42"])(
    "an element name that is not an identifier (%p) falls back to the position",
    elementName => {
      expect(name(usage("literal", { elementName }), 2)).toBe("el3");
    },
  );

  test("the fallback number is the position in the file, not a running counter", () => {
    const used = new Set<string>();
    expect(styleNameFor(usage("literal"), 2, used)).toBe("el3");
    expect(styleNameFor(usage("literal"), 7, used)).toBe("el8");
  });
});

describe("names never collide", () => {
  test("two divs are div and div2", () => {
    const used = new Set<string>();
    const div = usage("literal", { elementName: "div" });
    expect([styleNameFor(div, 0, used), styleNameFor(div, 1, used)]).toEqual(["div", "div2"]);
  });

  test("two variants with the same axis and value get suffixed", () => {
    const used = new Set<string>();
    const v = usage("cva-variant", { variantAxis: "size", variantValue: "sm" });
    expect(styleNameFor(v, 0, used)).toBe("sizeSm");
    expect(styleNameFor(v, 1, used)).toBe("sizeSm2");
  });

  test("values that differ only in punctuation stay distinct", () => {
    const used = new Set<string>();
    const a = usage("cva-variant", { variantAxis: "size", variantValue: "sm" });
    const b = usage("cva-variant", { variantAxis: "size", variantValue: "s-m" });
    expect([styleNameFor(a, 0, used), styleNameFor(b, 1, used)]).toEqual(["sizeSm", "sizeSM"]);
  });

  // A computed key (`{ [x]: '...' }`) gives no axis and no value. Camelising that produced "",
  // and `stylex.create({ '': {…} })` is not valid source.
  test("a variant with no readable key falls back to a positional name", () => {
    expect(name(usage("cva-variant", { variantAxis: "", variantValue: "" }), 3)).toBe("el4");
  });

  test("three collisions keep counting", () => {
    const used = new Set<string>();
    const v = usage("cva-base");
    expect([styleNameFor(v, 0, used), styleNameFor(v, 1, used), styleNameFor(v, 2, used)]).toEqual([
      "base",
      "base2",
      "base3",
    ]);
  });

  test("every name emitted is a valid JS identifier", () => {
    const used = new Set<string>();
    for (const [axis, value] of [
      ["size", "2xl"],
      ["variant", "outline/ghost"],
      ["state", "data-[open]"],
      ["", ""],
    ]) {
      expect(
        styleNameFor(usage("cva-variant", { variantAxis: axis, variantValue: value }), 0, used),
      ).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    }
  });
});

describe("the style object avoids names the file already uses", () => {
  const nameFor = (code: string): string => styleObjectName(nameIsTaken(code));

  test("a file with no clash gets the obvious name", () => {
    expect(nameFor(`import React from "react";\nimport { cn } from "./cn";\n`)).toBe("styles");
  });

  // A component with a `styles` prop shadows a module-level `const styles`, so
  // `stylex.props(styles.el1)` reads the prop and every style silently vanishes.
  test("a file that already binds styles gets a different one", () => {
    expect(nameFor(`export const C = ({ styles }) => <div />;`)).toBe("tw2sxStyles");
  });

  test("both taken keeps counting", () => {
    expect(nameFor(`const styles = 1; const tw2sxStyles = 2;`)).toBe("tw2sxStyles2");
    expect(nameFor(`const styles = 1, tw2sxStyles = 2, tw2sxStyles2 = 3;`)).toBe("tw2sxStyles3");
  });

  test("a longer name that merely contains the candidate does not count as a clash", () => {
    expect(nameFor(`const styleSheet = 1; const myStyles = 2;`)).toBe("styles");
  });
});
