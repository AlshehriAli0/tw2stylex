import { IDENT, type Style } from "./css-to-stylex.ts";
import type { Usage } from "./scan-file.ts";

const camelise = (s: string): string =>
  s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

const positionInFile = (index: number): string => `el${index + 1}`;

const axisAndValue = (usage: Usage): string =>
  camelise(`${usage.variantAxis}-${usage.variantValue}`);

const fromElement = (usage: Usage, index: number): string => {
  const name = lowerFirst(camelise(usage.elementName ?? ""));
  return IDENT.test(name) ? name : positionInFile(index);
};

const baseName = (usage: Usage, index: number): string => {
  if (usage.kind === "cva-base") return "base";
  if (usage.kind !== "cva-variant") return fromElement(usage, index);
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

export type Sheet = { styles: Record<string, Style>; add: (style: Style, name: string) => string };

export const newSheet = (): Sheet => {
  const styles: Record<string, Style> = {};
  const nameByStyle = new Map<string, string>();
  const add = (style: Style, name: string): string => {
    const key = JSON.stringify(style);
    const shared = nameByStyle.get(key);
    if (shared !== undefined) return shared;
    nameByStyle.set(key, name);
    styles[name] = style;
    return name;
  };
  return { styles, add };
};

const PREFERRED = ["styles", "tw2sxStyles"];

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
