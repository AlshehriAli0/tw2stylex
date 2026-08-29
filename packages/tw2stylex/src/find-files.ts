import fs from "node:fs";
import path from "node:path";

const ENTRY_CSS_LOCATIONS = [
  "src/index.css",
  "src/app.css",
  "src/styles/globals.css",
  "app/globals.css",
  "styles/globals.css",
  "index.css",
];

const PULLS_IN_TAILWIND = /@import\s+["']tailwindcss/;

export const findEntryCss = (from: string): string | undefined =>
  searchUp(from, ENTRY_CSS_LOCATIONS).find(
    file => fs.existsSync(file) && PULLS_IN_TAILWIND.test(fs.readFileSync(file, "utf8")),
  );

const CONFIG_LOCATIONS = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

export const findConfig = (from: string): string | undefined =>
  searchUp(from, CONFIG_LOCATIONS).find(file => fs.existsSync(file));

const searchUp = (from: string, locations: string[]): string[] =>
  [from, ...ancestors(from)].flatMap(dir => locations.map(rel => path.join(dir, rel)));

const ancestors = (dir: string): string[] => {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    const next = path.dirname(cur);
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
};

const SOURCE_FILE = /\.(?:tsx|jsx|ts|js)$/;

const isHidden = (name: string): boolean => name === "node_modules" || name.startsWith(".");

const isSource = (name: string): boolean => SOURCE_FILE.test(name) && !name.endsWith(".d.ts");

export const collectFiles = (target: string): string[] => {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (isHidden(e.name)) continue;
    const p = path.join(target, e.name);
    if (e.isDirectory()) out.push(...collectFiles(p));
    else if (isSource(e.name)) out.push(p);
  }
  return out;
};
