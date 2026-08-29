import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { BANNED_SHORTHANDS, resolveClasses } from "../src/classes-to-css.ts";
import { convert } from "../src/convert.ts";
import { loadDesignSystem, type LoadedSystem } from "../src/tailwind.ts";

let sys: LoadedSystem;
beforeAll(async () => {
  sys = await loadDesignSystem(path.join(import.meta.dir, "fixture.css"));
});

const run = (classes: string) => convert(sys.ds, "t", classes.split(/\s+/).filter(Boolean));
const skipsOf = (classes: string) => run(classes).skips;
const reasonsOf = (classes: string) => skipsOf(classes).map(s => s.reason);

describe("Tailwind's ! modifier is not silently dropped", () => {
  // StyleX has no importance. postcss keeps `!important` in a flag rather than the value, so
  // neither side of the gate saw it: `p-4!` converted to a plain `padding` and quietly stopped
  // winning whatever it was written to win.
  test.each(["p-4!", "text-red-500!", "hover:bg-accent!", "md:flex!"])(
    "%s is skipped, not converted",
    cls => {
      const out = run(cls);
      expect(out.skips.map(s => s.reason)).toContain("important-modifier");
      expect(out.style).toBeUndefined();
    },
  );

  test("the skip names the class, the property and the value at stake", () => {
    const skip = skipsOf("p-4!")[0];
    expect(skip?.class).toBe("p-4!");
    expect(skip?.detail).toContain("padding");
    expect(skip?.detail).toContain("!important");
  });

  test("the fix sends the agent looking for what the ! was beating", () => {
    expect(skipsOf("p-4!")[0]?.hint).toContain("beat");
  });

  test("the same class without the ! converts cleanly", () => {
    expect(run("p-4").style?.padding).toBe("calc(var(--spacing) * 4)");
  });
});

describe("shorthands StyleX drops are caught before they reach the compiler", () => {
  // Reaching the compiler would report `stylex-compile-error` - "this is a tw2sx bug" - for
  // something with a plain longhand rewrite. That happened for the block-direction borders.
  const VALUE_FOR: Record<string, string> = { all: "unset", animation: "a_1s" };

  test.each([...BANNED_SHORTHANDS])(
    "an arbitrary %s property is a dropped-shorthand skip",
    prop => {
      const reasons = reasonsOf(`[${prop}:${VALUE_FOR[prop] ?? "1px_solid_red"}]`);
      expect(reasons).toContain("dropped-shorthand");
      expect(reasons).not.toContain("stylex-compile-error");
    },
  );

  test("the hint names the longhands to write instead", () => {
    expect(skipsOf("[border-block-start:1px_solid_red]")[0]?.hint).toContain(
      "borderBlockStartWidth",
    );
  });

  test("animate-* points at stylex.keyframes rather than a longhand list", () => {
    expect(skipsOf("animate-spin")[0]?.hint).toContain("stylex.keyframes()");
  });
});

describe("what Tailwind emits that StyleX has no home for", () => {
  test("@starting-style is an unsupported at-rule, not a mystery", () => {
    expect(reasonsOf("starting:opacity-0")).toContain("unsupported-at-rule");
  });

  test("--tw-* plumbing is never emitted as a property", () => {
    const style = run("shadow-md").style ?? {};
    expect(Object.keys(style).some(k => k.startsWith("--tw-"))).toBe(false);
  });

  test("a composed value resolves to literals with no slots left behind", () => {
    const boxShadow = run("shadow-md").style?.boxShadow;
    expect(typeof boxShadow).toBe("string");
    expect(JSON.stringify(boxShadow)).not.toContain("var(--tw-");
  });
});

describe("a composition class with nothing to compose contributes nothing", () => {
  // v4's bare `transform` is `transform: var(--tw-rotate-x,) var(--tw-skew-y,) …`. With no
  // rotate or skew utility on the element every slot is empty, the browser drops the
  // declaration, and StyleX's value parser crashed on it - one usage in a real app.
  test.each(["transform", "filter", "backdrop-filter"])("%s alone emits no declaration", cls => {
    const out = run(cls);
    expect(out.skips).toEqual([]);
    expect(out.style).toBeUndefined();
  });

  test("it does not take its neighbours down with it", () => {
    const out = run("-translate-y-1/2 transform");
    expect(out.skips).toEqual([]);
    expect(out.style?.translate).toBeDefined();
    expect(out.style?.transform).toBeUndefined();
  });

  test("a slot that is actually filled still comes through", () => {
    expect(run("rotate-45 transform").style?.rotate).toBe("45deg");
  });

  test("the class set from the app that crashed the compiler now converts", () => {
    const out = run("absolute top-1/2 flex h-3/4 -translate-y-1/2 transform items-center gap-2");
    expect(out.skips).toEqual([]);
    expect(out.mismatches).toEqual([]);
    expect(out.style?.position).toBe("absolute");
  });
});

describe("at-rules StyleX can express survive as conditions", () => {
  test.each([
    ["md:flex", "@media (width >= 48rem)"],
    ["@md:flex", "@container (width >= 28rem)"],
    ["supports-[display:grid]:flex", "@supports (display:grid)"],
  ])("%s becomes %s", (cls, key) => {
    const display = run(cls).style?.display;
    expect(Object.keys(typeof display === "object" && display !== null ? display : {})).toContain(
      key,
    );
  });

  test("a vendor-prefixed property is kept alongside the standard one", () => {
    const style = run("backdrop-blur-sm").style ?? {};
    expect(style.WebkitBackdropFilter).toBeDefined();
    expect(style.backdropFilter).toBeDefined();
  });
});

describe("markers tell you which StyleX marker to define", () => {
  test("a bare group points at the default marker", () => {
    expect(skipsOf("group")[0]?.hint).toContain("stylex.defaultMarker()");
  });

  test("a named group asks for a named marker in a .stylex.ts file", () => {
    const hint = skipsOf("group/card")[0]?.hint ?? "";
    expect(hint).toContain("cardMarker");
    expect(hint).toContain("stylex.defineMarker()");
  });

  test("peer is a marker too", () => {
    expect(reasonsOf("peer")).toContain("marker-class");
  });
});

describe("duplicate causes are reported once", () => {
  test("two classes hitting the same problem give one skip each, not one per CSS rule", () => {
    const skips = skipsOf("space-x-2 space-y-2");
    expect(skips).toHaveLength(2);
    expect(new Set(skips.map(s => s.class)).size).toBe(2);
  });

  test("the same class twice is one skip", () => {
    expect(skipsOf("group group")).toHaveLength(1);
  });
});

describe("declarations are keyed by condition, last class wins within one", () => {
  test("two classes setting the same property under the same condition collapse to one", () => {
    const { declarations } = resolveClasses(sys.ds, ["p-2", "p-4"]);
    expect(declarations.size).toBe(1);
    expect([...declarations.values()][0]?.props.get("padding")).toBe("calc(var(--spacing) * 4)");
  });

  test("the same property under two conditions stays as two groups", () => {
    const { declarations } = resolveClasses(sys.ds, ["bg-brand", "hover:bg-accent"]);
    expect(declarations.size).toBeGreaterThan(1);
  });
});

/**
 * StyleX gives a longhand ID-level specificity (`.x:not(#\#)`), so it outranks a shorthand that
 * only applies under a condition. Tailwind resolves the same pair by stylesheet order, where the
 * conditional utility wins. The declaration sets match, so only this check catches the divergence.
 */
describe("a conditional shorthand that a longhand would beat", () => {
  test("is skipped rather than reported as converted", () => {
    const out = convert(sys.ds, "s", ["p-4", "pt-2", "hover:p-8"]);
    expect(out.skips.map(s => s.reason)).toEqual(["shorthand-beaten-by-longhand"]);
    expect(out.style).toBeUndefined();
  });

  test("the skip names both classes and both properties", () => {
    const [skip] = convert(sys.ds, "s", ["p-4", "pt-2", "hover:p-8"]).skips;
    expect(skip?.class).toBe("hover:p-8");
    expect(skip?.detail).toContain("pt-2");
    expect(skip?.detail).toContain("paddingTop");
  });

  test("one class can beat itself across its own condition", () => {
    expect(convert(sys.ds, "s", ["outline-hidden"]).skips.map(s => s.reason)).toEqual([
      "shorthand-beaten-by-longhand",
    ]);
  });

  test("a shorthand and longhand with no condition between them still converts", () => {
    expect(convert(sys.ds, "s", ["p-4", "pt-2"]).style).toEqual({
      padding: "calc(var(--spacing) * 4)",
      paddingTop: "calc(var(--spacing) * 2)",
    });
  });

  test("a longhand carrying the same condition still converts", () => {
    expect(convert(sys.ds, "s", ["p-4", "hover:pt-8"]).skips).toEqual([]);
  });

  test("a conditional shorthand with no longhand beside it still converts", () => {
    expect(convert(sys.ds, "s", ["p-4", "hover:p-8"]).skips).toEqual([]);
  });

  test("an unrelated longhand does not trip it", () => {
    expect(convert(sys.ds, "s", ["p-4", "hover:p-8", "mt-2"]).skips).toEqual([]);
  });
});
