import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyFile, dirtyFiles } from "../src/apply.ts";
import { processFile } from "../src/plan.ts";
import { scanFile } from "../src/scan-file.ts";
import { loadDesignSystem, type LoadedSystem } from "../src/tailwind.ts";

/**
 * The write path. Everything here runs against real files, because the bugs worth catching in
 * `apply` are about bytes on disk: a half-written file, a rewrite that moved code it should not
 * have touched, a second run that undoes the first.
 *
 * The workspace lives inside the repo so `tailwindcss` resolves the way it does for a user.
 */
let dir: string;
let sys: LoadedSystem;

const write = (name: string, code: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return file;
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(import.meta.dir, "tmp-apply-"));
  fs.copyFileSync(path.join(import.meta.dir, "fixture.css"), path.join(dir, "index.css"));
  sys = await loadDesignSystem(path.join(dir, "index.css"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a dry run is genuinely dry", () => {
  test("the file on disk is byte-identical afterwards", () => {
    const code = `export const A = () => <div className="flex p-4" />;\n`;
    const file = write("dry.tsx", code);

    const result = applyFile(sys, file, false);

    expect(result.written).toBe(false);
    expect(result.rewritten).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(code);
  });

  test("the result carries the full proposed file, so nothing has to be guessed", () => {
    const file = write("dry2.tsx", `export const A = () => <div className="flex" />;\n`);
    const { diff } = applyFile(sys, file, false);
    expect(diff).toContain("stylex.props(styles.div)");
    expect(diff).toContain("stylex.create");
  });
});

describe("writing produces a file that is still the same program", () => {
  const source = `import React from 'react';

export const Card = () => (
  <div className="flex items-center p-4">
    <span className="text-sm">hi</span>
  </div>
);
`;

  test("every className that converted becomes a props spread", () => {
    const file = write("card.tsx", source);
    const result = applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    expect(result.written).toBe(true);
    expect(result.rewritten).toBe(2);
    expect(out).toContain("{...stylex.props(styles.div)}");
    expect(out).toContain("{...stylex.props(styles.span)}");
    expect(out).not.toContain("className=");
  });

  test("the import and the create call are both added", () => {
    const file = write("card2.tsx", source);
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");
    expect(out).toContain(`import * as stylex from '@stylexjs/stylex';`);
    expect(out).toContain("const styles = stylex.create({");
  });

  test("code outside the className attributes is untouched", () => {
    const file = write("card3.tsx", source);
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");
    expect(out).toContain(`import React from 'react';`);
    expect(out).toContain("export const Card = () => (");
    expect(out).toContain(">hi<");
  });

  test("the result still parses as JSX", () => {
    const file = write("card4.tsx", source);
    applyFile(sys, file, true);
    // scanFile throws on unparseable input; reaching hasStyleX means it read cleanly.
    expect(scanFile(fs.readFileSync(file, "utf8"), file).hasStyleX).toBe(true);
  });

  test("a style name in the output has a matching entry in the create call", () => {
    const file = write("card5.tsx", source);
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");
    for (const name of ["div", "span"]) {
      expect(out).toContain(`stylex.props(styles.${name})`);
      expect(out).toContain(`${name}: {`);
    }
  });
});

describe("the import lands below the directive prologue", () => {
  // A directive is only a directive as the first statement. An import above "use client"
  // silently turns a client component into a server component.
  test('"use client" stays the first statement', () => {
    const file = write(
      "client.tsx",
      `"use client";\n\nexport const A = () => <div className="flex" />;\n`,
    );
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8")).toStartWith(
      `"use client";\nimport * as stylex from '@stylexjs/stylex';\n`,
    );
  });

  test("without a directive the import is the first line", () => {
    const file = write("plain-top.tsx", `export const A = () => <div className="flex" />;\n`);
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8")).toStartWith("import * as stylex");
  });
});

describe("repeated runs", () => {
  test("an already-migrated file is recognised and left alone", () => {
    const file = write("twice.tsx", `export const A = () => <div className="flex p-4" />;\n`);
    applyFile(sys, file, true);
    const afterFirst = fs.readFileSync(file, "utf8");

    const second = applyFile(sys, file, true);

    expect(second.reason).toBe("nothing-convertible");
    expect(second.skipped).toBe(0);
    expect(second.rewritten).toBe(0);
    expect(second.written).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
  });

  test("an existing StyleX namespace import is reused", () => {
    const code = `import * as stylex from '@stylexjs/stylex';\nexport const A = () => <div className="flex" />;\n`;
    const file = write("mixed.tsx", code);
    const result = applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    expect(result.rewritten).toBe(1);
    expect(out.match(/@stylexjs\/stylex/g)).toHaveLength(1);
    expect(out).toContain("stylex.props(styles.div)");
  });

  test("an aliased StyleX namespace import is reused", () => {
    const file = write(
      "aliased.tsx",
      `import * as sx from '@stylexjs/stylex';\nexport const A = () => <div className="flex" />;\n`,
    );
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    expect(out).toContain("sx.props(styles.div)");
    expect(out).toContain("const styles = sx.create({");
  });

  test("a StyleX import without a reusable namespace is left alone", () => {
    const code = `import { props } from '@stylexjs/stylex';\nexport const A = () => <div className="flex" />;\n`;
    const file = write("named-import.tsx", code);
    const result = applyFile(sys, file, true);

    expect(result.reason).toBe("already-stylex");
    expect(fs.readFileSync(file, "utf8")).toBe(code);
  });

  test("a partial migration resumes after a skipped usage is resolved", () => {
    const file = write(
      "resume.tsx",
      `export const A = () => (<div className="dark:text-white"><b className="flex" /></div>);\n`,
    );
    const first = applyFile(sys, file, true);
    const partial = fs.readFileSync(file, "utf8");

    expect(first.rewritten).toBe(1);
    expect(first.skipped).toBe(1);
    expect(partial).toContain(`className="dark:text-white"`);

    fs.writeFileSync(file, partial.replace("dark:text-white", "text-sm"));
    const second = applyFile(sys, file, false);

    expect(second.rewritten).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.diff?.match(/@stylexjs\/stylex/g)).toHaveLength(1);
    expect(second.diff).toContain("stylex.props(tw2sxStyles.div)");
    expect(second.diff).toContain("const styles = stylex.create({");
    expect(second.diff).toContain("const tw2sxStyles = stylex.create({");
  });
});

describe("apply refuses everything it cannot rewrite safely", () => {
  test.each([
    ["a component, not a host element", `export const A = () => <Card className="flex p-4" />;`],
    [
      "an element that also has a style prop",
      `export const A = () => <div className="flex" style={{ top: 0 }} />;`,
    ],
    [
      "a class the design system does not know",
      `export const A = () => <div className="not-a-class" />;`,
    ],
    [
      "a class that needs an ancestor",
      `export const A = () => <div className="dark:text-white" />;`,
    ],
    ["a descendant selector", `export const A = () => <div className="[&_svg]:size-4" />;`],
    ["a runtime-built class string", `export const A = ({ x }) => <div className={x} />;`],
    [
      "a member expression inside a merge call",
      `export const A = ({ tone }) => <div className={cn("flex p-4", TONE_BOX[tone])} />;`,
    ],
    ["no classes at all", `export const A = () => <div id="x" />;`],
    [
      "a className beside a stylex.props() spread",
      `import * as stylex from '@stylexjs/stylex';\nconst s = stylex.create({ a: { display: 'flex' } });\nexport const A = () => <div {...stylex.props(s.a)} className="p-4" />;`,
    ],
  ])("%s is left in place", (_name, code) => {
    const file = write(`refuse-${_name.replace(/\W+/g, "-")}.tsx`, `${code}\n`);
    const before = fs.readFileSync(file, "utf8");

    const result = applyFile(sys, file, true);

    expect(result.rewritten).toBe(0);
    expect(result.reason).toBe("nothing-convertible");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("nothing convertible means nothing written, not an empty write", () => {
    const file = write("none.tsx", `export const A = () => <div className="not-a-class" />;\n`);
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8")).not.toContain("stylex");
  });

  // A usage converts whole or not at all.
  test("one bad class in an attribute leaves that whole attribute alone", () => {
    const file = write(
      "partial.tsx",
      `export const A = () => <div className="flex p-4 dark:text-white" />;\n`,
    );
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8")).toContain(`className="flex p-4 dark:text-white"`);
  });

  test("a convertible element next to an unconvertible one is still converted", () => {
    const file = write(
      "neighbours.tsx",
      `export const A = () => (<div className="dark:text-white"><b className="flex" /></div>);\n`,
    );
    const result = applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    expect(result.rewritten).toBe(1);
    expect(result.skipped).toBe(1);
    expect(out).toContain(`className="dark:text-white"`);
    expect(out).toContain("stylex.props(styles.b)");
  });
});

describe("cva definitions are reported but never rewritten in place", () => {
  test("a cva call is left as source, because there is no attribute to replace", () => {
    const code = `import { cva } from 'class-variance-authority';\nexport const v = cva("flex p-4", { variants: { size: { sm: "p-1" } } });\n`;
    const file = write("cva.tsx", code);
    const result = applyFile(sys, file, true);
    expect(result.rewritten).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(code);
  });
});

describe("plan and apply agree on what converted", () => {
  const source = `export const A = () => (
  <div className="flex p-4">
    <span className="dark:text-white" />
    <b className="text-sm" />
    <Card className="flex" />
  </div>
);
`;

  test("apply never rewrites a usage plan reported as skipped", () => {
    const file = write("agree.tsx", source);
    const planned = processFile(sys, file);
    const names = new Set([...(planned.source ?? "").matchAll(/^\s{2}(\w+): \{/gm)].map(m => m[1]));

    applyFile(sys, file, true);
    const rewrittenNames = [
      ...fs.readFileSync(file, "utf8").matchAll(/stylex\.props\(styles\.(\w+)\)/g),
    ].map(m => m[1]);

    expect(rewrittenNames.length).toBeGreaterThan(0);
    for (const name of rewrittenNames) expect(names.has(name)).toBe(true);
  });

  test("a custom component is skipped by both", () => {
    const file = write("agree-component.tsx", source);
    const planned = processFile(sys, file);
    const applied = applyFile(sys, file, false);

    expect(planned.skips.map(skip => skip.reason)).toContain("component-class-name");
    expect([planned.converted, planned.skipped]).toEqual([applied.rewritten, applied.skipped]);
  });

  test("both sides name the usages the same way", () => {
    const file = write("agree2.tsx", source);
    const planned = processFile(sys, file);
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    for (const name of ["div", "b"]) {
      expect(planned.source).toContain(`${name}: {`);
      expect(out).toContain(`stylex.props(styles.${name})`);
    }
  });

  test("names from ids survive an element being inserted above them", () => {
    const card = `  <section id="billing" className="flex p-4">
    <h2 className="text-sm">Billing</h2>
    <button aria-label="Save billing" className={cn("flex", "p-2")}>Save</button>
  </section>`;
    const before = write("stable1.tsx", `export const A = () => (\n${card}\n);\n`);
    const after = write(
      "stable2.tsx",
      `export const A = () => (<>\n  <nav aria-label="Account" className="grid" />\n${card}\n</>);\n`,
    );
    const namesIn = (file: string): string[] =>
      [...(processFile(sys, file).source ?? "").matchAll(/^\s{2}(\w+): \{/gm)].map(m => m[1] ?? "");

    expect(namesIn(before)).toEqual(["billing", "h2", "saveBilling"]);
    expect(namesIn(after)).toEqual(["account", "billing", "h2", "saveBilling"]);
  });
});

describe("one style entry per distinct style", () => {
  const entriesIn = (source: string): string[] =>
    [...source.matchAll(/^\s{2}(\w+): \{/gm)].map(m => m[1] ?? "");

  test("two elements with the same classes share one entry", () => {
    const file = write(
      "dupe.tsx",
      `export const A = () => (<div className="flex p-4"><span className="flex p-4" /></div>);\n`,
    );
    const out = applyFile(sys, file, false).diff ?? "";

    expect(entriesIn(out)).toEqual(["div"]);
    expect(out.match(/stylex\.props\(styles\.div\)/g)).toHaveLength(2);
  });

  test("class order and cn() do not make a second entry", () => {
    const file = write(
      "dupe-order.tsx",
      `export const A = () => (<div className="flex p-4"><b className={cn("p-4", "flex")} /></div>);\n`,
    );
    const out = applyFile(sys, file, false).diff ?? "";

    expect(entriesIn(out)).toEqual(["div"]);
    expect(out).toContain("<b {...stylex.props(styles.div)} />");
  });

  test("a later usage keeps its own name once its style differs", () => {
    const file = write(
      "dupe-differs.tsx",
      `export const A = () => (<div className="flex"><span className="flex" /><span className="grid" /></div>);\n`,
    );
    const out = applyFile(sys, file, false).diff ?? "";

    expect(entriesIn(out)).toEqual(["div", "span2"]);
  });

  test("plan prints the same single entry and still counts every usage", () => {
    const file = write(
      "dupe-plan.tsx",
      `export const A = () => (<div className="flex p-4"><span className="flex p-4" /></div>);\n`,
    );
    const planned = processFile(sys, file);

    expect(entriesIn(planned.source ?? "")).toEqual(["div"]);
    expect(planned.converted).toBe(2);
  });
});

describe("the write itself is atomic", () => {
  test("no temp file is left behind", () => {
    const file = write("atomic.tsx", `export const A = () => <div className="flex" />;\n`);
    applyFile(sys, file, true);
    expect(fs.readdirSync(dir).filter(f => f.includes("tw2sx-"))).toEqual([]);
  });

  test("the file is never observed empty - the rename replaces it whole", () => {
    const file = write("atomic2.tsx", `export const A = () => <div className="flex" />;\n`);
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });
});

describe("the dirty-tree guard reads real git state", () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-git-"));
    const git = (...a: string[]): void => {
      execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("a clean repo reports nothing uncommitted", () => {
    expect(dirtyFiles(repo)).toEqual([]);
  });

  test("an edited file shows up", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    expect(dirtyFiles(repo)?.some(l => l.includes("a.txt"))).toBe(true);
  });

  // Not a repo is not the same as clean: apply must not treat "cannot tell" as "safe".
  test("outside a repo the answer is null, not an empty list", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-nogit-"));
    try {
      expect(dirtyFiles(loose)).toBeNull();
    } finally {
      fs.rmSync(loose, { recursive: true, force: true });
    }
  });
});

describe("the generated style object never collides with the file's own names", () => {
  test("a component with a styles prop still gets working styles", () => {
    const file = write(
      "shadowed.tsx",
      `export const A = ({ styles }: { styles: string[] }) => <div className="flex p-4">{styles.length}</div>;\n`,
    );
    applyFile(sys, file, true);
    const out = fs.readFileSync(file, "utf8");

    expect(out).toContain("const tw2sxStyles = stylex.create({");
    expect(out).toContain("stylex.props(tw2sxStyles.div)");
    expect(out).not.toContain("stylex.props(styles.");
  });

  test("plan reports the same object name apply writes", () => {
    const file = write(
      "shadowed2.tsx",
      `export const A = ({ styles }: { styles: string[] }) => <div className="flex">{styles.length}</div>;\n`,
    );
    const planned = processFile(sys, file);
    applyFile(sys, file, true);
    expect(planned.source).toContain("const tw2sxStyles = stylex.create({");
    expect(fs.readFileSync(file, "utf8")).toContain("stylex.props(tw2sxStyles.div)");
  });

  test("an unrelated file keeps the plain name", () => {
    const file = write("plain.tsx", `export const A = () => <div className="flex" />;\n`);
    applyFile(sys, file, true);
    expect(fs.readFileSync(file, "utf8")).toContain("const styles = stylex.create({");
  });
});
