import fs from "node:fs";
import path from "node:path";

import { findConfig, findEntryCss } from "./find-files.ts";

/**
 * `useCSSLayers` defaults to false in every StyleX bundler plugin, and false costs about a third
 * of the stylesheet: StyleX polyfills its priority order with `:not(#\#)` on nearly every rule.
 * Tailwind 4's output is already layered, so `true` is safe there as long as `@stylex;` follows
 * the Tailwind import. `init` makes that edit; everything else is a message.
 */
export type LayersOutcome =
  | { kind: "set"; file: string }
  | { kind: "already"; file: string }
  | { kind: "add-by-hand"; file: string }
  | { kind: "tailwind-3"; file: string }
  | { kind: "no-plugin" };

export type EntryOutcome = { file: string; stylex: "after" | "before" | "missing" } | undefined;

const CONFIG_FILE =
  /^(?:vite|vitest|next|postcss|webpack|rspack|rsbuild|rollup|esbuild|babel)\.config\.[cm]?[jt]sx?$|^\.babelrc(?:\.[cm]?js)?$/;
const PLUGIN_SOURCE =
  /["'](?:@stylexjs\/(?:unplugin(?:\/\w+)?|postcss-plugin)|@stylexswc\/\w+-plugin|vite-plugin-stylex)["']/;
const PLUGIN_IMPORT =
  /import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["'](?:@stylexjs\/unplugin(?:\/\w+)?|@stylexswc\/\w+-plugin|vite-plugin-stylex)["']/;
const POSTCSS_ENTRY = /["']@stylexjs\/postcss-plugin["']\s*:\s*\{/;
const OFF = /useCSSLayers\s*:\s*false/;
const ON = /useCSSLayers\s*:\s*true/;

export const findPluginConfig = (root: string): string | undefined =>
  fs
    .readdirSync(root)
    .filter(name => CONFIG_FILE.test(name))
    .map(name => path.join(root, name))
    .find(file => PLUGIN_SOURCE.test(fs.readFileSync(file, "utf8")));

const insertOption = (source: string): string | undefined => {
  const postcss = POSTCSS_ENTRY.exec(source);
  if (postcss) {
    const at = postcss.index + postcss[0].length;
    return `${source.slice(0, at)} useCSSLayers: true,${source.slice(at)}`;
  }
  const name = PLUGIN_IMPORT.exec(source)?.[1];
  if (name === undefined) return undefined;
  const call = new RegExp(`\\b${name}\\(\\s*(\\{|\\))`).exec(source);
  if (!call) return undefined;
  const at = call.index + call[0].length;
  return call[1] === "{"
    ? `${source.slice(0, at)} useCSSLayers: true,${source.slice(at)}`
    : `${source.slice(0, at - 1)}{ useCSSLayers: true })${source.slice(at)}`;
};

const isTailwind4 = (root: string): boolean =>
  findEntryCss(root) !== undefined || findConfig(root) === undefined;

export const enableCssLayers = (root: string): LayersOutcome => {
  const file = findPluginConfig(root);
  if (file === undefined) return { kind: "no-plugin" };
  const source = fs.readFileSync(file, "utf8");
  if (ON.test(source)) return { kind: "already", file };
  if (!isTailwind4(root)) return { kind: "tailwind-3", file };

  const next = OFF.test(source) ? source.replace(OFF, "useCSSLayers: true") : insertOption(source);
  if (next === undefined) return { kind: "add-by-hand", file };
  fs.writeFileSync(file, next);
  return { kind: "set", file };
};

export const checkEntryOrder = (root: string): EntryOutcome => {
  const file = findEntryCss(root);
  if (file === undefined) return undefined;
  const css = fs.readFileSync(file, "utf8");
  const directive = css.search(/@stylex\b/);
  const tailwind = css.search(/@import\s+["']tailwindcss/);
  if (directive === -1) return { file, stylex: "missing" };
  return { file, stylex: directive > tailwind ? "after" : "before" };
};

const LAYERS_MESSAGE: Record<LayersOutcome["kind"], string> = {
  set: "useCSSLayers set to true — a third less CSS than the :not(#\\#) polyfill.",
  already: "useCSSLayers already true.",
  "add-by-hand": 'add useCSSLayers: true to the StyleX plugin options (setup.md, "Two settings").',
  "tailwind-3":
    'useCSSLayers left off — Tailwind 3 is unlayered and would beat layered StyleX (setup.md, "Two settings").',
  "no-plugin": "No StyleX plugin config found at the project root; install one first (setup.md).",
};

export const describeLayers = (o: LayersOutcome): string =>
  "file" in o ? `${o.file}: ${LAYERS_MESSAGE[o.kind]}` : LAYERS_MESSAGE[o.kind];

export const describeEntry = (o: EntryOutcome): string | undefined => {
  if (o === undefined || o.stylex === "after") return undefined;
  return o.stylex === "missing"
    ? `${o.file}: add "@stylex;" after the Tailwind import, or StyleX emits no CSS.`
    : `${o.file}: move "@stylex;" below the Tailwind import, or Tailwind's layers win.`;
};
