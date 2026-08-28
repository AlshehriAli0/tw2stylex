import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import MagicString from "magic-string";

import { convert } from "./convert.ts";
import { printCreate, type Style } from "./css-to-stylex.ts";
import { scanFile, type ScanResult, type Usage } from "./scan-file.ts";
import { nameIsTaken, styleNameFor, styleObjectName } from "./style-name.ts";
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

export type Scanned = { file: string; code: string; scan: ScanResult };

export const readAndScan = (file: string): Scanned => {
  const code = fs.readFileSync(file, "utf8");
  return { file, code, scan: scanFile(code, file) };
};

export const applyScanned = (
  sys: LoadedSystem,
  { file, code, scan }: Scanned,
  write: boolean,
): ApplyFileResult => {
  const { usages, hasStyleX } = scan;

  if (hasStyleX)
    return { file, written: false, rewritten: 0, skipped: usages.length, reason: "already-stylex" };

  const objectName = styleObjectName(nameIsTaken(code));
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
    edits.update(range[0], range[1], `{...stylex.props(${objectName}.${name})}`);
    rewritten += 1;
  });

  if (!rewritten)
    return { file, written: false, rewritten: 0, skipped, reason: "nothing-convertible" };

  edits.prepend(`import * as stylex from '@stylexjs/stylex';\n`);
  edits.append(`\n\n${printCreate(styles, objectName)}\n`);
  const next = edits.toString();

  if (write) writeViaTempFile(file, next);
  return { file, written: write, rewritten, skipped, diff: write ? undefined : next };
};

export const applyFile = (sys: LoadedSystem, file: string, write: boolean): ApplyFileResult =>
  applyScanned(sys, readAndScan(file), write);
