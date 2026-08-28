import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import MagicString from "magic-string";

import { convert } from "./convert.ts";
import { printCreate, type Style } from "./emit.ts";
import { scanFile, type Usage } from "./extract.ts";
import type { LoadedSystem } from "./resolve.ts";
import { styleNameFor } from "./style-name.ts";

export type ApplyFileResult = {
  file: string;
  written: boolean;
  rewritten: number;
  skipped: number;
  reason?: string;
  diff?: string;
};

export const sha1 = (s: string): string => crypto.createHash("sha1").update(s).digest("hex");

/** Uncommitted paths under `dir`, or null when this is not a git repo. */
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

/**
 * The byte range to overwrite, when this usage is safe to rewrite in place: nothing skipped,
 * static classes, and an HTML element that can actually receive a props spread.
 */
const rewritableRange = (usage: Usage): [number, number] | undefined => {
  if (usage.skips.length > 0 || usage.classNames.length === 0) return undefined;
  if (usage.hostElement !== true) return undefined;
  if (usage.kind !== "literal" && usage.kind !== "cn-call") return undefined;
  return usage.range;
};

/** Write via a temp file in the same directory, then rename. Never leave a half-written file. */
const atomicWrite = (file: string, content: string): void => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tw2sx-${process.pid}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
};

/**
 * Rewrite one file: replace the className attributes we could fully convert with a
 * `stylex.props(...)` spread, and append the `stylex.create` call.
 *
 * All-or-nothing per file: if anything throws, the file is left untouched.
 * Whether a usage converts is `convert()`'s decision, the same one `plan` reports.
 */
export const applyFile = (sys: LoadedSystem, file: string, write: boolean): ApplyFileResult => {
  const code = fs.readFileSync(file, "utf8");
  const { usages, hasStyleX } = scanFile(code, file);

  // Already migrated: leave it alone so repeated runs are free and silent.
  if (hasStyleX)
    return { file, written: false, rewritten: 0, skipped: usages.length, reason: "already-stylex" };

  const edits = new MagicString(code);
  const styles: Record<string, Style> = {};
  const used = new Set<string>();
  let rewritten = 0;
  let skipped = 0;

  usages.forEach((usage, i) => {
    // The style name must match what `plan` reported, so every usage takes a number.
    const name = styleNameFor(usage, i, used);

    // Only a plain JSX attribute on an HTML element can take a props spread safely.
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

  if (write) atomicWrite(file, next);
  return { file, written: write, rewritten, skipped, diff: write ? undefined : next };
};
