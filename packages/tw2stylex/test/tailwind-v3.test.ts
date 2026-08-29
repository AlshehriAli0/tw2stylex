import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { convert } from "../src/convert.ts";
import { findConfig } from "../src/find-files.ts";
import { loadDesignSystem, type LoadedSystem } from "../src/tailwind.ts";

const tailwind3Root = path.dirname(
  createRequire(import.meta.url).resolve("tailwindcss3/package.json"),
);

const made: string[] = [];

const projectWithTailwind3Installed = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-v3-"));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.symlinkSync(tailwind3Root, path.join(dir, "node_modules/tailwindcss"));
  return dir;
};

const THEME = `{ extend: { colors: { brand: "#0af" }, spacing: { huge: "9rem" } } }`;

const CONFIG = `module.exports = { content: [], theme: ${THEME} };\n`;

const systemFor = async (body: string): Promise<LoadedSystem> => {
  const dir = projectWithTailwind3Installed({
    "tailwind.config.js": `module.exports = ${body};\n`,
  });
  return await loadDesignSystem(path.join(dir, "tailwind.config.js"));
};

let dir: string;
let sys: LoadedSystem;

beforeAll(async () => {
  dir = projectWithTailwind3Installed({
    "tailwind.config.js": CONFIG,
    "app/globals.css": "@tailwind base;\n@tailwind utilities;\n",
  });
  sys = await loadDesignSystem(path.join(dir, "tailwind.config.js"));
});

afterAll(() => {
  for (const made_ of made.splice(0)) fs.rmSync(made_, { recursive: true, force: true });
});

const styleOf = (classes: string[], of: LoadedSystem = sys): Record<string, unknown> => {
  const out = convert(of.ds, "s", classes);
  expect(out.skips).toEqual([]);
  return out.style ?? {};
};

const reasonsFor = (classes: string[], of: LoadedSystem = sys): string[] =>
  convert(of.ds, "s", classes).skips.map(s => s.reason);

describe("classes the project's own CSS defines or overrides", () => {
  let overriding: LoadedSystem;

  beforeAll(async () => {
    const project = projectWithTailwind3Installed({
      "tailwind.config.js": CONFIG,
      "app/globals.css": [
        "@tailwind base;",
        "@tailwind utilities;",
        "@layer utilities {",
        "  .font-medium, .font-semibold, .font-bold { font-weight: unset; }",
        '  .font-semibold { font-variation-settings: "wght" 600; }',
        "}",
        "@layer components { .btn { @apply p-4 font-semibold; } }",
        "",
      ].join("\n"),
    });
    overriding = await loadDesignSystem(path.join(project, "app/globals.css"));
  });

  // The browser applies the project's @layer rule after Tailwind's own, so `unset` is what
  // renders. Answering `600` here is the one way MISMATCHES: 0 has been wrong in the field.
  test("an @layer override of a core class wins, as it does in the browser", () => {
    expect(styleOf(["font-semibold"], overriding)).toEqual({
      fontWeight: "unset",
      fontVariationSettings: '"wght" 600',
    });
  });

  test("a class written with @apply resolves to what it applies", () => {
    expect(styleOf(["btn"], overriding)).toEqual({
      padding: "1rem",
      fontWeight: "unset",
      fontVariationSettings: '"wght" 600',
    });
  });

  test("without the entry CSS the core value stands", () => {
    expect(styleOf(["font-semibold"])).toEqual({ fontWeight: 600 });
  });
});

describe("a Tailwind 3 project", () => {
  test("reports the version it actually loaded", () => {
    expect(sys.version).toStartWith("3.");
  });

  test("converts plain utilities", () => {
    expect(styleOf(["flex", "items-center", "p-4"])).toEqual({
      display: "flex",
      alignItems: "center",
      padding: "1rem",
    });
  });

  test("reads the theme out of tailwind.config.js", () => {
    expect(styleOf(["text-brand", "w-huge"])).toEqual({
      color: "rgb(0 170 255 / 1)",
      width: "9rem",
    });
  });

  test("resolves arbitrary values, escaping and all", () => {
    expect(styleOf(["text-[13px]", "bg-[url(/a.png)]"])).toEqual({
      fontSize: "13px",
      backgroundImage: "url(/a.png)",
    });
  });

  test("a conflict resolves by Tailwind's stylesheet order, not by class-string order", () => {
    expect(styleOf(["p-8", "p-2"])).toEqual({ padding: "2rem" });
    expect(styleOf(["p-2", "p-8"])).toEqual({ padding: "2rem" });
  });
});

describe("slots the utility leaves for the @defaults at-rule to fill", () => {
  test("a transform fills every slot it does not set itself", () => {
    expect(styleOf(["rotate-45"])).toEqual({
      transform: "translate(0, 0) rotate(45deg) skewX(0) skewY(0) scaleX(1) scaleY(1)",
    });
  });

  test("an unset filter slot collapses instead of leaving whitespace behind", () => {
    expect(styleOf(["blur-sm"])).toEqual({ filter: "blur(4px)" });
  });

  test("two utilities sharing one slot list compose into a single value", () => {
    expect(styleOf(["blur-sm", "grayscale"])).toEqual({
      filter: "blur(4px) grayscale(100%)",
    });
  });

  test("a ring resolves through slots that reference other slots", () => {
    expect(styleOf(["ring-2"])).toEqual({
      boxShadow: "0 0 0 0px #fff, 0 0 0 calc(2px + 0px) rgb(59 130 246 / 0.5)",
    });
  });

  test("the @defaults at-rule itself never reaches the output", () => {
    expect(Object.keys(styleOf(["border"]))).toEqual(["borderWidth"]);
  });
});

describe("variants become StyleX conditions", () => {
  test("a breakpoint becomes a media query", () => {
    expect(styleOf(["md:flex"])).toEqual({
      display: { default: null, "@media (min-width: 768px)": "flex" },
    });
  });

  test("a pseudo-class becomes a self condition", () => {
    expect(styleOf(["hover:underline", "first:mt-0"])).toEqual({
      textDecorationLine: { default: null, ":hover": "underline" },
      marginTop: { default: null, ":first-child": "0px" },
    });
  });

  test("one utility spanning many breakpoints keeps all of them", () => {
    const width = styleOf(["container"]).maxWidth;
    expect(width).toMatchObject({
      "@media (min-width: 640px)": "640px",
      "@media (min-width: 1536px)": "1536px",
    });
  });
});

describe("what Tailwind 3 emits that StyleX has no home for", () => {
  test("a class Tailwind ranks but emits no CSS for is reported, not silently dropped", () => {
    expect(reasonsFor(["group"])).toEqual(["marker-class"]);
    expect(reasonsFor(["peer"])).toEqual(["marker-class"]);
  });

  test("a marker alongside real utilities still withholds the style", () => {
    const out = convert(sys.ds, "s", ["flex", "group"]);
    expect(out.skips.map(s => s.reason)).toEqual(["marker-class"]);
    expect(out.style).toBeUndefined();
  });

  test("the ! prefix is caught rather than quietly losing its precedence", () => {
    expect(reasonsFor(["!p-4"])).toEqual(["important-modifier"]);
    expect(styleOf(["p-4"])).toEqual({ padding: "1rem" });
  });

  test("an animation names both the @keyframes and the shorthand it cannot write", () => {
    expect(reasonsFor(["animate-spin"]).sort()).toEqual([
      "dropped-shorthand",
      "unsupported-at-rule",
    ]);
  });

  test("a utility that styles the children is not mistaken for one that styles the element", () => {
    expect(reasonsFor(["space-y-4"])).toEqual(["styles-children"]);
    expect(reasonsFor(["divide-y"])).toEqual(["styles-children"]);
  });

  test("a class Tailwind does not know is named as unknown", () => {
    expect(reasonsFor(["not-a-class"])).toEqual(["unknown-class"]);
  });

  test("class-based dark mode reads as a condition on an ancestor", async () => {
    const dark = await systemFor(`{ content: [], darkMode: "class", theme: ${THEME} }`);
    expect(reasonsFor(["dark:text-brand"], dark)).toEqual(["parent-state"]);
  });

  test("a group- variant reads as a condition on a marked ancestor", () => {
    expect(reasonsFor(["group-hover:opacity-100"])).toEqual(["sibling-state"]);
    expect(reasonsFor(["peer-checked:block"])).toEqual(["sibling-state"]);
  });

  test("an arbitrary child selector reads as reaching a descendant", () => {
    expect(reasonsFor(["[&>svg]:size-4"])).toEqual(["descendant-selector"]);
  });
});

describe("config knobs that only Tailwind 3 has", () => {
  test("prefix is honoured, so the prefixed class is the one that resolves", async () => {
    const prefixed = await systemFor(`{ content: [], prefix: "tw-", theme: ${THEME} }`);
    expect(styleOf(["tw-flex"], prefixed)).toEqual({ display: "flex" });
    expect(reasonsFor(["flex"], prefixed)).toEqual(["unknown-class"]);
  });

  test("separator is honoured, so variants split on it", async () => {
    const dashed = await systemFor(`{ content: [], separator: "_", theme: ${THEME} }`);
    expect(styleOf(["hover_underline"], dashed)).toEqual({
      textDecorationLine: { default: null, ":hover": "underline" },
    });
  });

  test("important: true turns every utility into a skip rather than a silent demotion", async () => {
    const loud = await systemFor(`{ content: [], important: true, theme: ${THEME} }`);
    expect(reasonsFor(["p-4"], loud)).toEqual(["important-modifier"]);
  });

  test("a plugin's utilities are in scope", async () => {
    const withPlugin = projectWithTailwind3Installed({
      "tailwind.config.js": `const plugin = require("tailwindcss/plugin");
module.exports = {
  content: [],
  theme: {},
  plugins: [plugin(({ addUtilities }) => addUtilities({ ".skew-none": { transform: "none" } }))],
};
`,
    });
    const loaded = await loadDesignSystem(path.join(withPlugin, "tailwind.config.js"));
    expect(styleOf(["skew-none"], loaded)).toEqual({ transform: "none" });
  });
});

describe("finding the config", () => {
  test("an entry CSS resolves to the config beside it", async () => {
    const viaCss = await loadDesignSystem(path.join(dir, "app/globals.css"));
    expect(viaCss.entry).toBe(path.join(dir, "tailwind.config.js"));
  });

  test("@config in the CSS wins over the search", async () => {
    const withDirective = projectWithTailwind3Installed({
      "theme/custom.config.js": CONFIG,
      "app/globals.css": '@config "../theme/custom.config.js";\n@tailwind utilities;\n',
    });
    const loaded = await loadDesignSystem(path.join(withDirective, "app/globals.css"));
    expect(loaded.entry).toBe(path.join(withDirective, "theme/custom.config.js"));
  });

  test.each(["js", "cjs", "mjs", "ts"])("tailwind.config.%s is a name we look for", ext => {
    const found = findConfig(projectWithTailwind3Installed({ [`tailwind.config.${ext}`]: CONFIG }));
    expect(found).toEndWith(`tailwind.config.${ext}`);
  });

  test("a TypeScript config loads, jiti and all", async () => {
    const typed = projectWithTailwind3Installed({
      "tailwind.config.ts": `import type { Config } from "tailwindcss";
const config: Config = { content: [], theme: { extend: { colors: { brand: "#f0a" } } } };
export default config;
`,
    });
    const loaded = await loadDesignSystem(path.join(typed, "tailwind.config.ts"));
    expect(styleOf(["text-brand"], loaded)).toEqual({ color: "rgb(255 0 170 / 1)" });
  });

  test("a project with no config at all says so", async () => {
    const bare = projectWithTailwind3Installed({ "app/globals.css": "@tailwind utilities;\n" });
    expect(loadDesignSystem(path.join(bare, "app/globals.css"))).rejects.toThrow(
      /tailwind\.config/,
    );
  });
});
