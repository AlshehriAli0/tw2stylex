import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./cjs.ts";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(packageRoot, "skills");

export const AGENT_HOMES = [
  { home: ".claude", agents: "Claude Code" },
  { home: ".agents", agents: "Codex, Gemini CLI" },
];

export const version = (): string => {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const declared = isRecord(parsed) ? parsed.version : undefined;
  return typeof declared === "string" ? declared : "unknown";
};

export const skillName = (): string => {
  const dirs = fs.readdirSync(source, { withFileTypes: true }).filter(d => d.isDirectory());
  const only = dirs[0];
  if (dirs.length !== 1 || only === undefined)
    throw new Error(`Expected exactly one skill in ${source}, found ${dirs.length}.`);
  return only.name;
};

export const homesPresent = (projectRoot: string): string[] =>
  AGENT_HOMES.map(h => h.home).filter(home => fs.existsSync(path.join(projectRoot, home)));

const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort();

const stampVersion = (front: string, stamp: string): string => {
  const end = front.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("SKILL.md has no frontmatter to stamp.");
  return `${front.slice(0, end)}\nmetadata:\n  package: tw2sx\n  version: "${stamp}"${front.slice(end)}`;
};

const writeSkill = (destination: string, name: string, stamp: string): void => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(source, name), destination, { recursive: true });

  const entry = path.join(destination, "SKILL.md");
  fs.writeFileSync(entry, stampVersion(fs.readFileSync(entry, "utf8"), stamp));
};

export const ignoreReports = (projectRoot: string): void => {
  const file = path.join(projectRoot, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const alreadyIgnored = current.split("\n").some(line => /^\.tw2sx\/?$/.test(line.trim()));
  if (alreadyIgnored) return;
  const onItsOwnLine = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, `${current}${onItsOwnLine}.tw2sx/\n`);
};

export const installedSkills = (projectRoot: string): string[] =>
  homesPresent(projectRoot)
    .map(home => path.join(home, "skills", skillName(), "SKILL.md"))
    .filter(skill => fs.existsSync(path.join(projectRoot, skill)));

export type Installed = { destinations: string[]; files: string[]; version: string };

export const installSkill = (projectRoot: string, homes: string[]): Installed => {
  const stamp = version();
  const name = skillName();
  const destinations = homes.map(home => path.join(projectRoot, home, "skills", name));

  for (const destination of destinations) writeSkill(destination, name, stamp);

  const first = destinations[0];
  if (first === undefined) throw new Error("installSkill needs at least one agent home.");
  return { destinations, files: filesUnder(first), version: stamp };
};
