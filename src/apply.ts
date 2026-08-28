import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import MagicString from "magic-string";

import { toNamespace, printCreate, type SxNamespace } from "./emit.ts";
import { scanFile, type Site } from "./extract.ts";
import { namespaceName } from "./pipeline.ts";
import { resolveElement } from "./reshape.ts";
import type { LoadedSystem } from "./resolve.ts";
import { verifyNamespace } from "./verify.ts";

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
 * The byte range to overwrite, when this site is safe to rewrite in place: no refusals,
 * static classes, and a host element that can actually receive a props spread.
 */
const rewritableRange = (site: Site): [number, number] | undefined => {
  if (site.refusals.length > 0 || site.candidates.length === 0) return undefined;
  if (site.hostElement !== true) return undefined;
  if (site.kind !== "literal" && site.kind !== "cn-call") return undefined;
  return site.range;
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
 * A site is only rewritten when it has zero refusals AND it verified.
 */
export const applyFile = (sys: LoadedSystem, file: string, write: boolean): ApplyFileResult => {
  const code = fs.readFileSync(file, "utf8");
  const { sites, hasStyleX } = scanFile(code, file);

  // Already migrated: leave it alone so repeated runs are free and silent.
  if (hasStyleX)
    return { file, written: false, rewritten: 0, skipped: sites.length, reason: "already-stylex" };

  const s = new MagicString(code);
  const namespaces: Record<string, SxNamespace> = {};
  const used = new Set<string>();
  let rewritten = 0;
  let skipped = 0;

  sites.forEach((site, i) => {
    // Only a clean JSX attribute on a host element can take a props spread safely.
    const range = rewritableRange(site);
    if (!range) {
      skipped++;
      return;
    }
    const resolved = resolveElement(sys.ds, site.candidates);
    if (resolved.refusals.length || !resolved.decls.size) {
      skipped++;
      return;
    }
    const name = namespaceName(site, i, used);
    const ns = toNamespace(resolved);
    if (!verifyNamespace(name, resolved, ns).ok) {
      skipped++;
      return;
    }
    namespaces[name] = ns;
    s.update(range[0], range[1], `{...stylex.props(styles.${name})}`);
    rewritten++;
  });

  if (!rewritten)
    return { file, written: false, rewritten: 0, skipped, reason: "nothing-convertible" };

  s.prepend(`import * as stylex from '@stylexjs/stylex';\n`);
  s.append(`\n\n${printCreate(namespaces)}\n`);
  const next = s.toString();

  if (write) atomicWrite(file, next);
  return { file, written: write, rewritten, skipped, diff: write ? undefined : next };
};
