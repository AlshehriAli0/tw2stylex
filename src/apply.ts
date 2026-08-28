import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import MagicString from "magic-string";

import { convert } from "./convert.ts";
import { printCreate, type Style } from "./css-to-stylex.ts";
import { scanFile, type Usage } from "./scan-file.ts";
import { styleNameFor } from "./style-name.ts";
import type { LoadedSystem } from "./tailwind.ts";

export type ApplyFileResult = {
  file: string;
  written: boolean;
  rewritten: number;
  skipped: number;
  reason?: string;
  diff?: string;
};

export const sha1 = (s: string): string => crypto.createHash("sha1").update(s).digest("hex");

export const dirtyFiles = (dir: string): string[] | null => {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
};

const isPlainJsxAttribute = (usage: Usage): boolean =>
  usage.kind === "literal" || usage.kind === "cn-call";

const rewritableRange = (usage: Usage): [number, number] | undefined => {
  if (usage.skips.length > 0 || usage.classNames.length === 0) return undefined;
  if (usage.onHostElement !== true) return undefined;
  if (!isPlainJsxAttribute(usage)) return undefined;
  return usage.attributeRange;
};

const writeViaTempFile = (file: string, content: string): void => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tw2sx-${process.pid}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
};

export const applyFile = (sys: LoadedSystem, file: string, write: boolean): ApplyFileResult => {
  const code = fs.readFileSync(file, "utf8");
  const { usages, hasStyleX } = scanFile(code, file);

  if (hasStyleX)
    return { file, written: false, rewritten: 0, skipped: usages.length, reason: "already-stylex" };

  const edits = new MagicString(code);
  const styles: Record<string, Style> = {};
  const used = new Set<string>();
  let rewritten = 0;
  let skipped = 0;

  usages.forEach((usage, i) => {
    const name = styleNameFor(usage, i, used);

    const range = rewritableRange(usage);
    const result = range ? convert(sys.ds, name, usage.classNames) : undefined;

    if (!range || !result?.style) {
      skipped += 1;
      return;
    }
    styles[name] = result.style;
    edits.update(range[0], range[1], `{...stylex.props(styles.${name})}`);
    rewritten += 1;
  });

  if (!rewritten)
    return { file, written: false, rewritten: 0, skipped, reason: "nothing-convertible" };

  edits.prepend(`import * as stylex from '@stylexjs/stylex';\n`);
  edits.append(`\n\n${printCreate(styles)}\n`);
  const next = edits.toString();

  if (write) writeViaTempFile(file, next);
  return { file, written: write, rewritten, skipped, diff: write ? undefined : next };
};
