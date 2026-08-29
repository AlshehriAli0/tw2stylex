import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { convert, warmUp } from "../src/convert.ts";
import { DEFAULT_FIX, fixFor, REASONS, type Reason } from "../src/skip.ts";
import { loadDesignSystem, type DesignSystem, type LoadedSystem } from "../src/tailwind.ts";

const FIXTURE = path.join(import.meta.dir, "fixture.css");
let sys: LoadedSystem;
beforeAll(async () => {
  sys = await loadDesignSystem(FIXTURE);
});

const run = (classes: string) => convert(sys.ds, "t", classes.split(/\s+/).filter(Boolean));

describe("convert decides once what counts as converted", () => {
  test("clean classes produce a style and no skips", () => {
    const out = run("flex items-center p-4");
    expect(out.skips).toEqual([]);
    expect(out.mismatches).toEqual([]);
    expect(out.style).toBeDefined();
    expect(out.rules).toBeGreaterThan(0);
  });

  // A usage converts whole or not at all. `plan` used to report a style here while
  // `apply` skipped it - 899 usages in a real codebase disagreed.
  test("one unconvertible class withholds the whole style", () => {
    const out = run("flex items-center p-4 [&_svg]:size-4");
    expect(out.style).toBeUndefined();
    expect(out.skips.map(s => s.reason)).toContain("descendant-selector");
  });

  test("a style is never returned alongside skips", () => {
    for (const classes of [
      "flex [&_svg]:size-4",
      "space-y-2",
      "group flex",
      "dark:text-white",
      "p-4 animate-spin",
      "bg-not-a-real-token",
    ]) {
      const out = run(classes);
      if (out.skips.length > 0) expect(out.style).toBeUndefined();
      else expect(out.style).toBeDefined();
    }
  });

  test("nothing to convert is not a skip", () => {
    const out = run("");
    expect(out.skips).toEqual([]);
    expect(out.style).toBeUndefined();
  });
});

/**
 * A design system we control, so the two branches a correct converter never reaches can still
 * be tested: the StyleX we generated failing to compile, and it compiling to the wrong thing.
 */
const stubSystem = (css: Record<string, string>): DesignSystem => ({
  getClassOrder: names =>
    names.map((n, i): [string, bigint | null] => [n, n in css ? BigInt(i) : null]),
  candidatesToCss: names => names.map(n => css[n] ?? null),
  slotDefaults: new Map(),
});

describe("when our own output is wrong, we say so and convert nothing", () => {
  // A compound selector leaves ".other" as the condition, and StyleX rejects anything that is
  // not a pseudo or an at-rule.
  const uncompilable = stubSystem({ x: `.x { color: red }\n.x.other { color: blue }\n` });

  test("a compile error is reported as our bug, not as a class the user should fix", () => {
    const out = convert(uncompilable, "t", ["x"]);
    expect(out.skips.map(s => s.reason)).toEqual(["stylex-compile-error"]);
    expect(out.skips[0]?.hint).toContain("tw2sx bug");
  });

  test("a compile error still withholds the style", () => {
    const out = convert(uncompilable, "t", ["x"]);
    expect(out.style).toBeUndefined();
    expect(out.rules).toBe(0);
  });

  test("the compiler's own message is carried through, trimmed to the useful line", () => {
    const detail = convert(uncompilable, "t", ["x"]).skips[0]?.detail ?? "";
    expect(detail).toContain("Invalid pseudo or at-rule");
    expect(detail).not.toContain("\n");
  });

  // StyleX minifies through lightningcss; a value that comes back different is a real
  // disagreement about what will ship, whichever side is "right".
  const disagrees = stubSystem({ y: `.y { transition-duration: 0.50s }\n` });

  test("a value StyleX rewrites is caught as a mismatch", () => {
    const out = convert(disagrees, "t", ["y"]);
    expect(out.mismatches).toHaveLength(1);
    expect(out.mismatches[0]?.property).toBe("transition-duration");
    expect(out.mismatches[0]?.tailwind).toBe("0.50s");
  });

  test("a mismatch withholds the style and files a lost-condition skip", () => {
    const out = convert(disagrees, "t", ["y"]);
    expect(out.style).toBeUndefined();
    expect(out.skips.map(s => s.reason)).toEqual(["lost-condition"]);
    expect(out.skips[0]?.hint).toContain("mismatches");
  });

  test("the skip counts the mismatches so the summary line is honest", () => {
    expect(convert(disagrees, "t", ["y"]).skips[0]?.detail).toContain("1 place(s)");
  });
});

describe("skip vocabulary is complete and honest", () => {
  test("every reason has a fix type", () => {
    for (const reason of REASONS) expect(DEFAULT_FIX[reason]).toBeDefined();
  });

  test("a skip can override its reason's default fix", () => {
    const base = { reason: "unknown-class" as Reason, detail: "d", hint: "h" };
    expect(fixFor(base)).toBe("unknown");
    expect(fixFor({ ...base, fix: "safe" })).toBe("safe");
  });

  // Our own bugs must never be labelled safe to batch-fix.
  test("a compile error is never marked safe", () => {
    expect(DEFAULT_FIX["stylex-compile-error"]).not.toBe("safe");
    expect(DEFAULT_FIX["lost-condition"]).not.toBe("safe");
  });

  test("reason codes stay kebab-case so agents can match on them", () => {
    for (const reason of REASONS) expect(reason).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

/**
 * `warmUp` verifies the whole run in one StyleX compile, so one style StyleX rejects would take
 * every other style down with it. The batch halves until the culprit is alone; these pin that the
 * survivors still convert and the culprit is still named, whichever position it sits in.
 */
describe("one uncompilable style does not poison the batch", () => {
  const mixed = stubSystem({
    good: `.good { color: red }\n`,
    alsogood: `.alsogood { display: flex }\n`,
    third: `.third { margin-top: 4px }\n`,
    bad: `.bad { color: red }\n.bad.other { color: blue }\n`,
  });

  const classesOf = (...names: string[]): string[][] => names.map(n => [n]);

  test("the good styles convert and the bad one is named", () => {
    warmUp(mixed, classesOf("good", "alsogood", "bad", "third"));
    expect(convert(mixed, "a", ["good"]).style).toBeDefined();
    expect(convert(mixed, "b", ["alsogood"]).style).toBeDefined();
    expect(convert(mixed, "c", ["third"]).style).toBeDefined();
    expect(convert(mixed, "d", ["bad"]).skips.map(s => s.reason)).toEqual(["stylex-compile-error"]);
  });

  test("the culprit is found wherever it sits in the batch", () => {
    for (const order of [
      ["bad", "good", "alsogood", "third"],
      ["good", "alsogood", "third", "bad"],
      ["good", "bad", "third", "alsogood"],
    ]) {
      const fresh = stubSystem({
        good: `.good { color: red }\n`,
        alsogood: `.alsogood { display: flex }\n`,
        third: `.third { margin-top: 4px }\n`,
        bad: `.bad { color: red }\n.bad.other { color: blue }\n`,
      });
      warmUp(fresh, classesOf(...order));
      expect(convert(fresh, "x", ["bad"]).style).toBeUndefined();
      for (const ok of ["good", "alsogood", "third"])
        expect(convert(fresh, "x", [ok]).style).toBeDefined();
    }
  });

  /**
   * Without this, the test passes whether or not the batch splits: anything warmUp fails to
   * memoise, convert just recomputes. Sealing the system after warmUp makes recomputation
   * impossible, so a good style that still converts can only have come from the batch.
   */
  test("the survivors are memoised by warmUp, not recomputed later", () => {
    let sealed = false;
    const base = stubSystem({
      good: `.good { color: red }\n`,
      bad: `.bad { color: red }\n.bad.other { color: blue }\n`,
    });
    const sealing: DesignSystem = {
      ...base,
      candidatesToCss: names => {
        if (sealed) throw new Error("recomputed after warmUp");
        return base.candidatesToCss(names);
      },
    };

    warmUp(sealing, classesOf("good", "bad"));
    sealed = true;

    expect(convert(sealing, "x", ["good"]).style).toBeDefined();
    expect(convert(sealing, "x", ["bad"]).skips.map(s => s.reason)).toEqual([
      "stylex-compile-error",
    ]);
  });
});
