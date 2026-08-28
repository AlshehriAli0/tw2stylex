import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_HOMES, homesPresent, installSkill, skillName, version } from "../src/init.ts";

let project = "";

const skillDir = (home: string): string =>
  path.join(project, home, "skills", "migrating-tailwind-to-stylex");

const install = (): ReturnType<typeof installSkill> => installSkill(project, homesPresent(project));

const entry = (home: string): string =>
  fs.readFileSync(path.join(skillDir(home), "SKILL.md"), "utf8");

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "tw2sx-init-"));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

/**
 * One SKILL.md format, two directories. Getting the set wrong is invisible: an agent that cannot
 * see the skill behaves exactly like an agent that has no skill for the job.
 */
describe("which agent homes it writes to", () => {
  test("only the ones the project already has", () => {
    fs.mkdirSync(path.join(project, ".agents"));
    expect(homesPresent(project)).toEqual([".agents"]);
    expect(install().destinations).toEqual([skillDir(".agents")]);
  });

  test("both when both are there", () => {
    for (const { home } of AGENT_HOMES) fs.mkdirSync(path.join(project, home));
    expect(install().destinations).toEqual([skillDir(".claude"), skillDir(".agents")]);
  });

  test("none when the project has no agent directory", () => {
    expect(homesPresent(project)).toEqual([]);
  });

  test("Codex reads .agents, so .agents is one of the homes", () => {
    expect(AGENT_HOMES.map(h => h.home)).toContain(".agents");
  });
});

describe("what it writes", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(project, ".claude"));
  });

  test("the whole skill, references included", () => {
    const installed = install();
    expect(installed.destinations).toEqual([skillDir(".claude")]);
    expect(installed.files).toContain("SKILL.md");
    expect(installed.files.some(f => f.startsWith("references/"))).toBe(true);
  });

  test("every reference file the repo has", () => {
    const repo = path.join(import.meta.dir, "..", "skills", "migrating-tailwind-to-stylex");
    const installed = install();
    for (const file of fs.readdirSync(path.join(repo, "references")))
      expect(installed.files).toContain(path.join("references", file));
  });

  /**
   * The installed copy is the one an agent loads next session, and the only place that can tell
   * the agent it has gone stale. Unstamped, an old copy naming reasons the tool no longer
   * produces reads exactly like a current one.
   */
  test("the tool version, stamped into the copy", () => {
    install();
    expect(entry(".claude")).toContain(`version: "${version()}"`);
  });

  test("frontmatter that still parses, name intact", () => {
    install();
    const block = /^---\n([\s\S]*?)\n---\n/.exec(entry(".claude"))?.[1];
    expect(block).toContain(`name: ${skillName()}`);
    expect(block).toContain("package: tw2sx");
  });

  test("one stamp, however many times it runs", () => {
    install();
    install();
    expect([...entry(".claude").matchAll(/^metadata:$/gm)]).toHaveLength(1);
  });

  test("nothing a previous install left behind", () => {
    install();
    const stale = path.join(skillDir(".claude"), "references", "gone.md");
    fs.writeFileSync(stale, "old");
    install();
    expect(fs.existsSync(stale)).toBe(false);
  });

  test("nothing outside its own directory", () => {
    const settings = path.join(project, ".claude", "settings.json");
    fs.writeFileSync(settings, "{}");
    install();
    expect(fs.existsSync(settings)).toBe(true);
  });
});

describe("tw2sx --version", () => {
  test("reports the published version, not a placeholder", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
