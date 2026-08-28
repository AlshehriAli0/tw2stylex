import type { Usage } from "./scan-file.ts";

const camelise = (s: string): string =>
  s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");

const positionInFile = (index: number): string => `el${index + 1}`;

const axisAndValue = (usage: Usage): string =>
  camelise(`${usage.variantAxis}-${usage.variantValue}`);

const baseName = (usage: Usage, index: number): string => {
  if (usage.kind === "cva-base") return "base";
  if (usage.kind !== "cva-variant") return positionInFile(index);
  return axisAndValue(usage) || positionInFile(index);
};

export const styleNameFor = (usage: Usage, index: number, used: Set<string>): string => {
  const base = baseName(usage, index);
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  used.add(name);
  return name;
};

const PREFERRED = ["styles", "tw2sxStyles"];

/**
 * Only a handful of names are ever candidates, so asking the text about those beats collecting
 * every identifier in the file. A match inside a comment or a string counts as taken, which costs
 * nothing but the next name on the list.
 */
export const nameIsTaken =
  (code: string) =>
  (name: string): boolean =>
    new RegExp(`\\b${name}\\b`).test(code);

export const styleObjectName = (taken: (name: string) => boolean): string => {
  const free = PREFERRED.find(name => !taken(name));
  if (free !== undefined) return free;
  let n = 2;
  while (taken(`tw2sxStyles${n}`)) n += 1;
  return `tw2sxStyles${n}`;
};
