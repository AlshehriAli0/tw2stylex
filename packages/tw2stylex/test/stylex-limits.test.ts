import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { compileStyleX } from "../src/check.ts";
import { requireExport } from "../src/cjs.ts";
import { BANNED_SHORTHANDS } from "../src/classes-to-css.ts";

/**
 * What StyleX will and will not accept, asked of StyleX itself rather than copied into a
 * comment. Every claim the skill makes about StyleX's limits is checked here, so upgrading
 * @stylexjs/babel-plugin fails these tests instead of silently changing what we generate.
 */

const camel = (prop: string): string =>
  prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

const compileProp = (prop: string, value: string): { rules: string[] } | { error: string } => {
  const r = compileStyleX(
    `const styles = stylex.create({ t: { ${camel(prop)}: ${JSON.stringify(value)} } });`,
  );
  return "error" in r ? r : { rules: r.rules.map(x => x.css) };
};

// A value that is valid for every shorthand in the list, so a failure means the property was
// rejected rather than the value.
const SHORTHAND_VALUE: Record<string, string> = { all: "unset", animation: "a 1s" };

describe("the banned-shorthand list matches what StyleX actually rejects", () => {
  // This list drifted once already: border-block-start and border-block-end were missing, so
  // they reached the compiler and came back as `stylex-compile-error` - "this is a tw2stylex bug" -
  // when the real answer was a longhand rewrite the agent could have done.
  test.each([...BANNED_SHORTHANDS])("%s is rejected by StyleX", prop => {
    const r = compileProp(prop, SHORTHAND_VALUE[prop] ?? "1px solid red");
    expect("error" in r ? r.error : "").toContain("is not supported");
  });

  // The other half of the invariant: nothing on this list is banned by us alone.
  test.each([
    ["margin", "1px"],
    ["padding", "1px"],
    ["inset", "1px"],
    ["flex", "1"],
    ["transition", "all 1s"],
    ["font", "12px serif"],
    ["grid-area", "a"],
    ["border-radius", "1px"],
    ["outline", "1px solid red"],
    ["gap", "1px"],
    ["overflow", "hidden"],
    ["text-decoration", "underline"],
    ["border-inline-width", "1px"],
    ["border-block-start-width", "1px"],
  ])("%s is allowed and we do not ban it", (prop, value) => {
    expect(BANNED_SHORTHANDS.has(prop)).toBe(false);
    const r = compileProp(prop, value);
    expect("error" in r).toBe(false);
  });
});

describe("the failures the skill calls silent are the ones that are silent", () => {
  // Descendant and child selectors are the one loud failure. If StyleX ever downgrades this to
  // a warning we would start emitting broken styles, so the loudness itself is the assertion.
  test.each(["> *", " svg", "& .child"])("a descendant selector (%s) throws", selector => {
    const r = compileStyleX(
      `const styles = stylex.create({ t: { ${JSON.stringify(selector)}: { color: 'red' } } });`,
    );
    expect("error" in r).toBe(true);
  });

  test("a self condition with a default compiles", () => {
    const r = compileStyleX(
      `const styles = stylex.create({ t: { color: { default: 'red', ':hover': 'blue' } } });`,
    );
    expect("error" in r ? r.error : "").toBe("");
  });

  // The overwriting rule from SKILL.md, proved rather than asserted: a flat value on a second
  // style leaves exactly one rule for that property, so the :hover from the first is gone.
  test("a flat value emits one rule where a conditional value emits two", () => {
    const conditional = compileStyleX(
      `const styles = stylex.create({ t: { color: { default: 'red', ':hover': 'blue' } } });`,
    );
    const flat = compileStyleX(`const styles = stylex.create({ t: { color: 'green' } });`);
    expect("error" in conditional ? 0 : conditional.rules.length).toBe(2);
    expect("error" in flat ? 0 : flat.rules.length).toBe(1);
  });

  test("a condition with no default is dropped without an error", () => {
    // Silent: it compiles, and the rule simply is not there.
    const r = compileStyleX(
      `const styles = stylex.create({ t: { color: { ':hover': 'blue' } } });`,
    );
    expect("error" in r).toBe(false);
  });

  test("finite variant branches fold props calls without changing CSS", () => {
    const definitions = `const styles = stylex.create({
      base: { display: 'flex' },
      neutral: { color: 'black' },
      danger: { color: 'white' },
    });`;
    const dynamic = compileStyleX(`${definitions}
      const variants = { neutral: styles.neutral, danger: styles.danger };
      const propsFor = tone => stylex.props(styles.base, variants[tone]);`);
    const finite = compileStyleX(`${definitions}
      const propsFor = tone => tone === 'neutral'
        ? stylex.props(styles.base, styles.neutral)
        : stylex.props(styles.base, styles.danger);`);

    expect("error" in dynamic).toBe(false);
    expect("error" in finite).toBe(false);
    if ("error" in dynamic || "error" in finite) return;

    expect(dynamic.rules).toEqual(finite.rules);
    expect(dynamic.code).toContain("stylex.props");
    expect(finite.code).not.toContain("stylex.props");
  });
});

describe("the CSS-size claims in css-size.md hold for this StyleX", () => {
  const rulesOf = (source: string) => {
    const r = compileStyleX(source);
    return "error" in r ? [] : r.rules;
  };

  test("a namespace's name is not part of the atom hash, so one per element is free", () => {
    const rules = rulesOf(
      `const styles = stylex.create({ card: { padding: '1rem' }, div2: { padding: '1rem' } });`,
    );
    expect(rules).toHaveLength(1);
  });

  test("the value string is the atom key: '1rem' and 16 are two rules, '0px' and 0 are one", () => {
    const drift = rulesOf(
      `const styles = stylex.create({ a: { padding: '1rem' }, b: { padding: 16 } });`,
    );
    const zero = rulesOf(
      `const styles = stylex.create({ a: { padding: '0px' }, b: { padding: 0 } });`,
    );
    expect(new Set(drift.map(r => r.className)).size).toBe(2);
    expect(new Set(zero.map(r => r.className)).size).toBe(1);
  });

  test("without layers the priority polyfill appends :not(#\\#) to rules", () => {
    const plugin: unknown = createRequire(import.meta.url)("@stylexjs/babel-plugin");
    const { processStylexRules } = requireExport(
      plugin,
      "processStylexRules",
      "@stylexjs/babel-plugin",
    );
    if (typeof processStylexRules !== "function") throw new Error("processStylexRules missing");
    const rules = rulesOf(
      `const styles = stylex.create({ t: { padding: '1rem', paddingTop: 0, color: { default: 'red', ':hover': 'blue' } } });`,
    ).map(r => [r.className, { ltr: r.css, rtl: null }, r.priority]);

    const unlayered = String(processStylexRules(rules, false));
    const layered = String(processStylexRules(rules, true));
    expect(unlayered).toContain(":not(#\\#)");
    expect(layered).not.toContain(":not(#\\#)");
    expect(layered).toContain("@layer priority");
  });
});
