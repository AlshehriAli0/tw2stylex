import fs from "node:fs";
import path from "node:path";

/** Find the project's Tailwind entry CSS by looking for an @import "tailwindcss". */
export const findEntryCss = (from: string): string | undefined => {
  const roots = [from, ...ancestors(from)];
  for (const dir of roots) {
    for (const rel of [
      "src/index.css",
      "src/app.css",
      "src/styles/globals.css",
      "app/globals.css",
      "styles/globals.css",
      "index.css",
    ]) {
      const f = path.join(dir, rel);
      if (fs.existsSync(f) && /@import\s+["']tailwindcss/.test(fs.readFileSync(f, "utf8")))
        return f;
    }
  }
  return undefined;
};

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

export const collectFiles = (target: string): string[] => {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(target, e.name);
    if (e.isDirectory()) out.push(...collectFiles(p));
    else if (SOURCE_FILE.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
};
