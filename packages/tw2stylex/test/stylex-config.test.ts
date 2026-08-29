import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkEntryOrder, enableCssLayers } from "../src/stylex-config.ts";

/**
 * `useCSSLayers` is off by default and costs a third of the stylesheet. `init` turns it on where
 * that is safe (Tailwind 4, whose output is already layered) and says why it did not elsewhere.
 */
let project = "";

const write = (name: string, content: string): string => {
  const file = path.join(project, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const read = (name: string): string => fs.readFileSync(path.join(project, name), "utf8");

const tailwind4 = (): void => {
  write("src/index.css", '@import "tailwindcss";\n@stylex;\n');
};

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "tw2stylex-layers-"));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("turning useCSSLayers on", () => {
  test("false becomes true under Tailwind 4", () => {
    tailwind4();
    write(
      "vite.config.ts",
      `import stylex from '@stylexjs/unplugin/vite';\nexport default { plugins: [stylex({ useCSSLayers: false }), react()] };\n`,
    );
    expect(enableCssLayers(project).kind).toBe("set");
    expect(read("vite.config.ts")).toContain("useCSSLayers: true");
    expect(read("vite.config.ts")).not.toContain("useCSSLayers: false");
  });

  test("an absent option is inserted into the plugin call", () => {
    tailwind4();
    write(
      "vite.config.ts",
      `import stylexPlugin from '@stylexjs/unplugin/vite';\nexport default { plugins: [stylexPlugin({ dev: false }), react()] };\n`,
    );
    expect(enableCssLayers(project).kind).toBe("set");
    expect(read("vite.config.ts")).toContain("stylexPlugin({ useCSSLayers: true, dev: false })");
  });

  test("an empty plugin call gains an options object", () => {
    tailwind4();
    write(
      "vite.config.ts",
      `import stylex from '@stylexjs/unplugin/vite';\nexport default { plugins: [stylex(), react()] };\n`,
    );
    expect(enableCssLayers(project).kind).toBe("set");
    expect(read("vite.config.ts")).toContain("stylex({ useCSSLayers: true })");
  });

  test("the PostCSS plugin's options object is handled too", () => {
    tailwind4();
    write(
      "postcss.config.js",
      `module.exports = { plugins: { '@stylexjs/postcss-plugin': { include: ['src/**/*.tsx'] } } };\n`,
    );
    expect(enableCssLayers(project).kind).toBe("set");
    expect(read("postcss.config.js")).toContain(
      "'@stylexjs/postcss-plugin': { useCSSLayers: true, include:",
    );
  });

  test("already true is left alone", () => {
    tailwind4();
    const before = `import stylex from '@stylexjs/unplugin/vite';\nexport default { plugins: [stylex({ useCSSLayers: true })] };\n`;
    write("vite.config.ts", before);
    expect(enableCssLayers(project).kind).toBe("already");
    expect(read("vite.config.ts")).toBe(before);
  });

  test("Tailwind 3 is unlayered, so the file is untouched and the outcome says why", () => {
    write("tailwind.config.js", "module.exports = {};\n");
    const before = `import stylex from '@stylexjs/unplugin/vite';\nexport default { plugins: [stylex({ useCSSLayers: false })] };\n`;
    write("vite.config.ts", before);
    expect(enableCssLayers(project).kind).toBe("tailwind-3");
    expect(read("vite.config.ts")).toBe(before);
  });

  test("no plugin config means nothing to edit", () => {
    tailwind4();
    write("vite.config.ts", `export default { plugins: [react()] };\n`);
    expect(enableCssLayers(project).kind).toBe("no-plugin");
  });
});

describe("the CSS entrypoint order", () => {
  test("@stylex after the Tailwind import is right", () => {
    tailwind4();
    expect(checkEntryOrder(project)?.stylex).toBe("after");
  });

  test("@stylex before the import would lose to Tailwind's layers", () => {
    write("src/index.css", '@stylex;\n@import "tailwindcss";\n');
    expect(checkEntryOrder(project)?.stylex).toBe("before");
  });

  test("no @stylex at all is reported", () => {
    write("src/index.css", '@import "tailwindcss";\n');
    expect(checkEntryOrder(project)?.stylex).toBe("missing");
  });
});
