/**
 * Bumps packages/tw2sx to the next patch, minor or major and prints the new version.
 * The release workflow reads that number back to tag and name the release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KINDS = ["patch", "minor", "major"] as const;
type Kind = (typeof KINDS)[number];

const isKind = (v: string): v is Kind => KINDS.some(kind => kind === v);

const next = (version: string, kind: Kind): string => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const kind = process.argv[2] ?? "patch";
if (!isKind(kind)) throw new Error(`bump takes ${KINDS.join(", ")}, got "${kind}"`);

const file = path.resolve(import.meta.dirname, "../packages/tw2sx/package.json");
const source = readFileSync(file, "utf8");
const current = /"version": "([^"]+)"/.exec(source)?.[1];
if (current === undefined) throw new Error(`no version field in ${file}`);

const bumped = next(current, kind);
writeFileSync(file, source.replace(`"version": "${current}"`, `"version": "${bumped}"`));
console.log(bumped);
