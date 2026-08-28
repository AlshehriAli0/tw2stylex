import type { Usage } from "./extract.ts";

const camelise = (s: string): string =>
  s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");

const baseName = (usage: Usage, index: number): string => {
  const positional = `el${index + 1}`;
  if (usage.kind === "cva-base") return "base";
  if (usage.kind !== "cva-variant") return positional;
  // A computed key (`{ [x]: '...' }`) leaves the axis and value empty, and camelising that
  // gives "" - a style named "" is not valid JS and breaks the whole create call.
  return camelise(`${usage.variantAxis}-${usage.variantValue}`) || positional;
};

/**
 * Name a style after where it came from, never `$1`/`$2`.
 *
 * `index` is the usage's position in the file, so the same usage gets the same name whether
 * it is being reported or rewritten - `plan` and `apply` must agree on what `styles.el2` means.
 */
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
