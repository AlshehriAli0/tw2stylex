import { describe, expect, test } from "bun:test";

import { scanFile, type Usage } from "../src/scan-file.ts";

const scan = (code: string): Usage[] => scanFile(code, "x.tsx").usages;
const first = (code: string): Usage | undefined => scan(code)[0];
const classesIn = (code: string): string[] => first(code)?.classNames ?? [];
const reasonsIn = (code: string): string[] => scan(code).flatMap(u => u.skips.map(s => s.reason));

describe("static class strings are read whole", () => {
  test("a plain string attribute", () => {
    expect(classesIn(`<div className="flex p-4" />`)).toEqual(["flex", "p-4"]);
  });

  test("the `class` attribute counts too, for non-React JSX", () => {
    expect(classesIn(`<div class="flex" />`)).toEqual(["flex"]);
  });

  test("extra whitespace and newlines are not classes", () => {
    expect(classesIn(`<div className="  flex\n  p-4  " />`)).toEqual(["flex", "p-4"]);
  });

  test("a template literal with no interpolation is just a string", () => {
    const usage = first("<div className={`flex p-4`} />");
    expect(usage?.classNames).toEqual(["flex", "p-4"]);
    expect(usage?.skips).toEqual([]);
  });

  test.each(["div", "Card"])("an empty className on %s is not a usage at all", tag => {
    expect(scan(`<${tag} className="" />`)).toEqual([]);
  });

  test("an attribute that is not className is ignored", () => {
    expect(scan(`<div id="flex" data-class="p-4" />`)).toEqual([]);
  });
});

describe("merge helpers are transparent", () => {
  test.each(["cn", "clsx", "classnames", "twMerge", "twJoin", "cx"])("%s is seen through", fn => {
    expect(classesIn(`<div className={${fn}("flex", "p-4")} />`)).toEqual(["flex", "p-4"]);
  });

  test("a namespaced call is matched on the property name", () => {
    expect(classesIn(`<div className={utils.cn("flex")} />`)).toEqual(["flex"]);
  });

  test("nesting them is still transparent", () => {
    expect(classesIn(`<div className={cn("flex", clsx("p-4", ["gap-2"]))} />`)).toEqual([
      "flex",
      "p-4",
      "gap-2",
    ]);
  });

  test("an array of strings is flattened", () => {
    expect(classesIn(`<div className={cn(["flex", "p-4"])} />`)).toEqual(["flex", "p-4"]);
  });

  test("a merge call is tagged cn-call, a bare string literal", () => {
    expect(first(`<div className={cn("flex")} />`)?.kind).toBe("cn-call");
    expect(first(`<div className="flex" />`)?.kind).toBe("literal");
  });
});

describe("anything built at runtime is reported with the classes we could still see", () => {
  test("a ternary keeps both branches and says it is dynamic", () => {
    const usage = first(`<div className={on ? "flex" : "hidden"} />`);
    expect(usage?.classNames).toEqual(["flex", "hidden"]);
    expect(usage?.skips.map(s => s.reason)).toEqual(["dynamic-classes"]);
  });

  test("a && keeps the right-hand side", () => {
    const usage = first(`<div className={cn("flex", open && "rotate-180")} />`);
    expect(usage?.classNames).toEqual(["flex", "rotate-180"]);
    expect(usage?.skips.map(s => s.reason)).toEqual(["dynamic-classes"]);
  });

  test("an interpolated template keeps its static chunks", () => {
    const usage = first(["<div className={`flex ", "{x} p-4`} />"].join("$"));
    expect(usage?.classNames).toEqual(["flex", "p-4"]);
    expect(usage?.skips[0]?.detail).toContain("1 interpolation");
  });

  test("an object map contributes its keys", () => {
    const usage = first(`<div className={cn({ "flex gap-2": a, hidden: b })} />`);
    expect(usage?.classNames).toEqual(["flex", "gap-2", "hidden"]);
    expect(usage?.skips.map(s => s.reason)).toEqual(["dynamic-classes"]);
  });

  test("a numeric key in an object map does not crash the read", () => {
    expect(classesIn(`<div className={cn({ 2: a })} />`)).toEqual(["2"]);
  });

  test("a computed key contributes nothing but is still reported", () => {
    const usage = first(`<div className={cn({ [k]: a })} />`);
    expect(usage?.classNames).toEqual([]);
    expect(usage?.skips.map(s => s.reason)).toEqual(["dynamic-classes"]);
  });

  test("an unknown call names itself and suggests the merge list", () => {
    const skip = first(`<div className={makeClasses()} />`)?.skips[0];
    expect(skip?.reason).toBe("dynamic-classes");
    expect(skip?.detail).toContain("makeClasses()");
    expect(skip?.hint).toContain("merge-function list");
  });

  test.each(["TONE_BOX[tone]", "tone.box"])(
    "a member expression (%s) keeps visible classes and is reported",
    expression => {
      const usage = first(`<div className={cn("flex", ${expression})} />`);
      expect(usage?.classNames).toEqual(["flex"]);
      expect(usage?.skips.map(s => s.reason)).toEqual(["dynamic-classes"]);
    },
  );

  test("each dynamic hint says what to write instead", () => {
    expect(first(`<div className={a ? "flex" : "hidden"} />`)?.skips[0]?.hint).toContain(
      "separate styles",
    );
    expect(first(`<div className={cn(a && "flex")} />`)?.skips[0]?.hint).toContain("stylex.props");
  });

  test("every dynamic skip points at the line it came from", () => {
    const usage = first(`\n\n<div className={a ? "flex" : "hidden"} />`);
    expect(usage?.skips[0]?.detail).toContain("line 3");
  });
});

describe("a className flowing in from outside changes the component's API", () => {
  test("a bare identifier is passed-in-classes, not dynamic-classes", () => {
    const usage = first(`<div className={className} />`);
    expect(usage?.skips.map(s => s.reason)).toEqual(["passed-in-classes"]);
    expect(usage?.skips[0]?.detail).toContain(`"className"`);
  });

  test("the hint points at the style prop contract", () => {
    expect(first(`<div className={cn("flex", extra)} />`)?.skips[0]?.hint).toContain(
      "StyleXStylesWithout",
    );
  });

  test("a variable inside a merge call still reports, and the literals survive", () => {
    const usage = first(`<div className={cn("flex", className)} />`);
    expect(usage?.classNames).toEqual(["flex"]);
    expect(usage?.skips.map(s => s.reason)).toEqual(["passed-in-classes"]);
  });

  test("a call that looks like cva output is named precisely", () => {
    const skip = first(`<div className={cn(buttonVariants({ size: "sm" }))} />`)?.skips[0];
    expect(skip?.reason).toBe("variant-function");
    expect(skip?.hint).toContain("buttonVariants");
  });
});

describe("an element with two styling sources cannot take a props spread", () => {
  test("className plus style is reported", () => {
    const usage = first(`<div className="flex" style={{ top: 0 }} />`);
    expect(usage?.skips.map(s => s.reason)).toContain("two-style-sources");
  });

  test("the skip names the line of the style attribute", () => {
    const usage = first(`<div\n  className="flex"\n  style={{ top: 0 }}\n/>`);
    expect(usage?.skips.find(s => s.reason === "two-style-sources")?.detail).toContain("line 3");
  });

  test("className alone is fine", () => {
    expect(reasonsIn(`<div className="flex" />`)).toEqual([]);
  });
});

describe("only host elements can receive a props spread", () => {
  test.each(["div", "span", "button", "my-element"])("%s is a host element", tag => {
    expect(reasonsIn(`<${tag} className="flex" />`)).toEqual([]);
  });

  test.each(["Card", "MyCard", "Foo.Bar"])("%s is a component", tag => {
    expect(reasonsIn(`<${tag} className="flex" />`)).toEqual(["component-class-name"]);
  });
});

describe("the byte range covers the whole attribute", () => {
  test("replacing that range swaps className for a spread and nothing else", () => {
    const code = `<div className="flex" id="x" />`;
    const range = first(code)?.attributeRange ?? [0, 0];
    expect(code.slice(range[0], range[1])).toBe(`className="flex"`);
  });

  test("a cva usage has no range, because there is no attribute to replace", () => {
    const usages = scan(`const v = cva("flex");`);
    expect(usages[0]?.attributeRange).toBeUndefined();
  });
});

describe("cva definitions are pulled apart by axis and value", () => {
  const code = `
    const button = cva("inline-flex p-2", {
      variants: {
        size: { sm: "text-sm", lg: "text-lg" },
        variant: { ghost: "bg-transparent" },
      },
      defaultVariants: { size: "sm" },
    });
  `;

  test("the base string is one usage", () => {
    const base = scan(code).filter(u => u.kind === "cva-base");
    expect(base).toHaveLength(1);
    expect(base[0]?.classNames).toEqual(["inline-flex", "p-2"]);
  });

  test("every variant value is its own usage, tagged with axis and value", () => {
    const variants = scan(code).filter(u => u.kind === "cva-variant");
    expect(variants.map(v => [v.variantAxis, v.variantValue])).toEqual([
      ["size", "sm"],
      ["size", "lg"],
      ["variant", "ghost"],
    ]);
  });

  test("defaultVariants is configuration, not classes", () => {
    expect(scan(code).some(u => u.classNames.includes("sm"))).toBe(false);
  });

  test("cva with no config is still a base", () => {
    expect(scan(`const v = cva("flex");`)).toHaveLength(1);
  });

  test("cva with no arguments produces nothing rather than throwing", () => {
    expect(scan(`const v = cva();`)).toEqual([]);
  });

  test("a dynamic variant value is reported inside its own usage", () => {
    const usages = scan(`const v = cva("flex", { variants: { size: { sm: cond ? "a" : "b" } } });`);
    expect(usages.find(u => u.kind === "cva-variant")?.skips.map(s => s.reason)).toEqual([
      "dynamic-classes",
    ]);
  });
});

describe("a file that already uses StyleX is recognised", () => {
  test.each([
    `import * as stylex from '@stylexjs/stylex';`,
    `import { props } from '@stylexjs/stylex';`,
    `import '@stylexjs/open-props/colors.stylex';`,
  ])("%s marks the file", line => {
    expect(scanFile(line, "x.tsx").hasStyleX).toBe(true);
  });

  test("an unrelated import does not", () => {
    expect(scanFile(`import x from 'stylex-lookalike';`, "x.tsx").hasStyleX).toBe(false);
  });
});

describe("parsing is tolerant enough to keep going", () => {
  test("TypeScript syntax is understood", () => {
    expect(classesIn(`const A = (p: { x: number }) => <div className="flex" />;`)).toEqual([
      "flex",
    ]);
  });

  test("a decorator does not stop the scan", () => {
    expect(classesIn(`@dec class A { render() { return <div className="flex" />; } }`)).toEqual([
      "flex",
    ]);
  });

  test("locations are 1-based on both axes, so editors can jump to them", () => {
    const usage = first(`<div className="flex" />`);
    expect(usage?.loc).toEqual({ line: 1, column: 6 });
  });
});

/**
 * Usages are numbered el1, el2, ... in the order they are found, so the walk order is part of the
 * generated output. An element nested inside another element's attribute value must still come
 * after the attributes written before it, which is the one case where reading attributes off
 * their element instead of visiting them in place gives a different answer.
 */
describe("usages come out in document order", () => {
  const classesInOrder = (src: string): string[][] =>
    scanFile(src, "t.tsx").usages.map(u => u.classNames);

  test("an element inside an earlier attribute is found before the later attribute", () => {
    const src = `export const A = () => <div icon={<Icon className="inner" />} className="outer" />;`;
    expect(classesInOrder(src)).toEqual([["inner"], ["outer"]]);
  });

  test("an element inside a later attribute is found after the earlier attribute", () => {
    const src = `export const A = () => <div className="outer" icon={<Icon className="inner" />} />;`;
    expect(classesInOrder(src)).toEqual([["outer"], ["inner"]]);
  });

  test("children come after every attribute of their parent", () => {
    const src = `export const A = () => <div className="parent"><span className="child" /></div>;`;
    expect(classesInOrder(src)).toEqual([["parent"], ["child"]]);
  });

  test("the element is still known, so a style attribute beside it is still caught", () => {
    const src = `export const A = () => <div icon={<Icon className="inner" />} className="outer" style={{ top: 0 }} />;`;
    const outer = scanFile(src, "t.tsx").usages.find(u => u.classNames[0] === "outer");
    expect(outer?.skips.map(s => s.reason)).toEqual(["two-style-sources"]);
  });
});
