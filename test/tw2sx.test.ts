import { describe, expect, test, beforeAll } from "bun:test";
import path from "node:path";

import { toStyle, printCreate } from "../src/emit.ts";
import { scanFile } from "../src/extract.ts";
import { resolveClasses, selfSelector } from "../src/reshape.ts";
import { loadDesignSystem, type LoadedSystem } from "../src/resolve.ts";
import { checkStyle, compileStyleX } from "../src/verify.ts";

const FIXTURE = path.join(import.meta.dir, "fixture.css");
let sys: LoadedSystem;
beforeAll(async () => {
  sys = await loadDesignSystem(FIXTURE);
});

const run = (classes: string) => {
  const resolved = resolveClasses(sys.ds, classes.split(/\s+/).filter(Boolean));
  const ns = toStyle(resolved);
  return { resolved, ns, verdict: checkStyle("t", resolved, ns) };
};
const reasons = (classes: string) =>
  run(classes)
    .resolved.skips.map(r => r.reason)
    .sort();

describe("the project design system is the source of truth", () => {
  test("reads the fixture @theme, not stock Tailwind", () => {
    expect(run("bg-brand").ns.backgroundColor).toBe("var(--color-brand)");
    // @theme inline substitutes the value rather than emitting a variable.
    expect(run("bg-primary").ns.backgroundColor).toBe("rgb(var(--primary))");
  });
  test("a class the design system does not define is refused, not guessed", () => {
    expect(reasons("bg-not-a-real-token")).toContain("unknown-class");
  });
});

describe("conflict order follows Tailwind, not the class attribute", () => {
  // Tailwind resolves by stylesheet order; twMerge would answer p-2 and hidden here.
  test("p-4 p-2 keeps p-4", () => {
    expect(run("p-4 p-2").ns.padding).toBe("calc(var(--spacing) * 4)");
    expect(run("p-2 p-4").ns.padding).toBe("calc(var(--spacing) * 4)");
  });
  test("hidden flex keeps hidden", () => {
    expect(run("hidden flex").ns.display).toBe("none");
    expect(run("flex hidden").ns.display).toBe("none");
  });
});

describe("conditions become nested values with a default", () => {
  test("hover carries v4 hover-capability media query", () => {
    expect(run("bg-brand hover:bg-accent").ns.backgroundColor).toEqual({
      default: "var(--color-brand)",
      ":hover": { default: null, "@media (hover: hover)": "rgb(var(--accent))" },
    });
  });
  test("a responsive-only property gets a null default", () => {
    expect(run("md:flex").ns.display).toEqual({ default: null, "@media (width >= 48rem)": "flex" });
  });
  test("data attributes are self-conditions", () => {
    expect(run("data-[state=open]:bg-accent").ns.backgroundColor).toEqual({
      default: null,
      '[data-state="open"]': "rgb(var(--accent))",
    });
  });
  test("StyleX allows one nesting level, so selectors collapse into one key", () => {
    const bg = run("data-disabled:data-checked:bg-brand").ns.backgroundColor as Record<
      string,
      unknown
    >;
    expect(Object.keys(bg)).toContain("[data-disabled][data-checked]");
  });
});

describe("--tw-* composition chains resolve to literals", () => {
  test("shadow and ring compose into one box-shadow with colours intact", () => {
    const v = run("shadow-md ring-2").ns.boxShadow as string;
    expect(v).toContain("rgb(0 0 0 / 0.1)");
    expect(v).toContain("currentcolor");
    expect(v).not.toContain("--tw-");
  });
  test("text-sm resolves its line-height fallback", () => {
    expect(run("text-sm").ns.lineHeight).toBe("var(--text-sm--line-height)");
  });
});

describe("skips are typed and complete", () => {
  test.each([
    ["[&_svg]:size-4", "descendant-selector"],
    ["space-y-2", "styles-children"],
    ["divide-y", "styles-children"],
    ["group-hover:underline", "sibling-state"],
    ["dark:text-white", "parent-state"],
    ["animate-spin", "dropped-shorthand"],
    ["group", "marker-class"],
    ["group/card", "marker-class"],
    ["peer", "marker-class"],
  ])("%s is refused as %s", (cls, reason) => {
    expect(reasons(cls)).toContain(reason);
  });

  test("every skip names the class it blames and says what to do", () => {
    for (const skip of run("[&_svg]:size-4 space-y-2 group dark:text-white").resolved.skips) {
      expect(skip.hint.length).toBeGreaterThan(20);
      expect(skip.class).toBeDefined();
      expect(skip.detail).toContain(String(skip.class));
    }
  });
});

describe("selfSelector distinguishes self from relational", () => {
  test.each([
    ["&:hover", ":hover"],
    ['&[data-state="open"]', '[data-state="open"]'],
    [".foo:disabled", ":disabled"],
  ])("%s is a self condition", (sel, expected) => {
    expect(selfSelector(sel, "foo")).toBe(expected);
  });
  test.each(["&:is(.dark *)", "& > *", "& .child", "&:is(:where(.group):hover *)"])(
    "%s reaches another element",
    sel => {
      expect(selfSelector(sel, "foo")).toBeNull();
    },
  );
  test("escaped commas inside a value do not split the selector list", () => {
    expect(
      selfSelector(".ease-\\[cubic-bezier\\(0\\.22\\,1\\)\\]", "ease-[cubic-bezier(0.22,1)]"),
    ).toBe("");
  });
});

// ADR-0003: a gate that cannot fail is not a gate.
describe("the verification gate catches real breakage", () => {
  test("a dropped declaration is caught", () => {
    const { resolved, ns } = run("flex p-4");
    delete ns.padding;
    const v = checkStyle("t", resolved, ns);
    expect(v.ok).toBe(false);
    expect(v.kind === "mismatch" && v.mismatches[0].property).toBe("padding");
  });
  test("a wrong value is caught", () => {
    const { resolved, ns } = run("p-4");
    ns.padding = "calc(var(--spacing) * 8)";
    expect(checkStyle("t", resolved, ns).ok).toBe(false);
  });
  test("condition erasure is caught", () => {
    const { resolved, ns } = run("bg-brand hover:bg-accent");
    ns.backgroundColor = "var(--color-brand)"; // flat override wipes :hover
    const v = checkStyle("t", resolved, ns);
    expect(v.ok).toBe(false);
    expect(v.kind === "mismatch" && v.mismatches.some(m => m.condition.includes(":hover"))).toBe(
      true,
    );
  });
  test("a banned shorthand is a compile error, not silence", () => {
    const r = compileStyleX(`const styles = stylex.create({ t: { background: 'red' } });`);
    expect("error" in r && r.error).toContain("background is not supported");
  });
  test("a descendant selector is a compile error", () => {
    const r = compileStyleX(`const styles = stylex.create({ t: { '> *': { color: 'red' } } });`);
    expect("error" in r).toBe(true);
  });
  test("clean output verifies", () => {
    for (const c of [
      "flex items-center gap-2 p-4",
      "text-sm hover:bg-accent md:flex",
      "shadow-md ring-2",
    ])
      expect(run(c).verdict.ok).toBe(true);
  });
});

describe("extraction finds usages and names them", () => {
  const src = `
    import { cva } from 'class-variance-authority';
    const v = cva("flex p-4", { variants: { size: { sm: "p-1", lg: "p-8" } } });
    export const C = ({ className }) => <div className={cn("flex gap-2", className)} />;
    export const D = () => <span className="text-sm" />;
  `;
  const scan = scanFile(src, "x.tsx");
  test("finds cva base, each variant value, and jsx usages", () => {
    expect(scan.usages.filter(s => s.kind === "cva-base")).toHaveLength(1);
    expect(scan.usages.filter(s => s.kind === "cva-variant")).toHaveLength(2);
    expect(scan.usages.some(s => s.classNames.includes("text-sm"))).toBe(true);
  });
  test("a className prop flowing in is a passed-in-classes skip", () => {
    const all = scan.usages.flatMap(s => s.skips);
    expect(all.some(r => r.reason === "passed-in-classes")).toBe(true);
  });
});

// Regressions for two bugs that only showed up at scale.
describe("regressions", () => {
  test("compiling many namespaces stays deterministic", () => {
    // StyleX hashes class names off the filename; reusing one virtual filename made
    // results depend on how many files had already been processed.
    const once = run("grid-cols-1 sm:grid-cols-2").verdict;
    for (let i = 0; i < 30; i++) run("flex p-4 hover:bg-accent");
    const again = run("grid-cols-1 sm:grid-cols-2").verdict;
    expect(once.ok).toBe(true);
    expect(again.ok).toBe(true);
  });

  test("several breakpoints on one property all survive", () => {
    // StyleX narrows overlapping min-width queries into non-overlapping ranges unless
    // enableMediaQueryOrder is off; that used to read as 4 dropped declarations.
    const { verdict, ns } = run("grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4");
    expect(verdict.ok).toBe(true);
    expect(Object.keys(ns.gridTemplateColumns as object)).toHaveLength(4);
  });

  test("an escaped comma in an arbitrary value does not split the selector", () => {
    expect(run("ease-[cubic-bezier(0.22,1,0.36,1)]").verdict.ok).toBe(true);
  });
});

describe("emitted source is valid StyleX", () => {
  test("printCreate output compiles", () => {
    const { ns } = run("flex items-center p-4 hover:bg-accent md:flex-col");
    const r = compileStyleX(printCreate({ card: ns }));
    expect("error" in r).toBe(false);
  });
  test("namespaces are named, never positional", () => {
    expect(printCreate({ card: run("flex").ns })).toContain("card:");
  });
});
