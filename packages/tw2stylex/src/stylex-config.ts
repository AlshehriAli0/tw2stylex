import fs from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";
import * as t from "@babel/types";
import postcss from "postcss";

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
  | { kind: "unconfirmed-tailwind"; file: string }
  | { kind: "no-plugin" };

export type EntryOutcome = { file: string; stylex: "after" | "before" | "missing" } | undefined;

const CONFIG_FILE =
  /^(?:vite|vitest|next|postcss|webpack|rspack|rsbuild|rollup|esbuild|babel)\.config\.[cm]?[jt]sx?$|^\.babelrc(?:\.[cm]?js)?$/;
const PLUGIN_MODULE =
  /^(?:@stylexjs\/(?:unplugin(?:\/\w+)?|postcss-plugin)|@stylexswc\/\w+-plugin|vite-plugin-stylex)$/;
const PLUGIN_IMPORT =
  /import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["'](?:@stylexjs\/unplugin(?:\/\w+)?|@stylexswc\/\w+-plugin|vite-plugin-stylex)["']/;
const POSTCSS_ENTRY = /["']@stylexjs\/postcss-plugin["']\s*:\s*\{/;

const parseConfig = (source: string): t.File =>
  parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  });

const referencesPlugin = (node: t.Node): boolean => {
  if (t.isImportDeclaration(node)) return PLUGIN_MODULE.test(node.source.value);
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: "require" }) &&
    t.isStringLiteral(node.arguments[0])
  )
    return PLUGIN_MODULE.test(node.arguments[0].value);
  return (
    t.isObjectProperty(node) &&
    !node.computed &&
    t.isStringLiteral(node.key, { value: "@stylexjs/postcss-plugin" })
  );
};

const containsPlugin = (source: string): boolean => {
  let ast: t.File;
  try {
    ast = parseConfig(source);
  } catch {
    return false;
  }
  return t.traverseFast(ast, node => (referencesPlugin(node) ? t.traverseFast.stop : undefined));
};

const pluginOptionObjects = (ast: t.File, source: string): t.ObjectExpression[] => {
  const name = PLUGIN_IMPORT.exec(source)?.[1];
  const objects: t.ObjectExpression[] = [];
  t.traverseFast(ast, node => {
    if (
      name !== undefined &&
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name }) &&
      t.isObjectExpression(node.arguments[0])
    )
      objects.push(node.arguments[0]);
    if (
      t.isObjectProperty(node) &&
      !node.computed &&
      t.isStringLiteral(node.key, { value: "@stylexjs/postcss-plugin" }) &&
      t.isObjectExpression(node.value)
    )
      objects.push(node.value);
  });
  return objects;
};

const booleanLayerOption = (node: t.Node): t.BooleanLiteral | undefined => {
  if (!t.isObjectProperty(node) || node.computed) return undefined;
  if (
    !t.isIdentifier(node.key, { name: "useCSSLayers" }) &&
    !t.isStringLiteral(node.key, { value: "useCSSLayers" })
  )
    return undefined;
  return t.isBooleanLiteral(node.value) ? node.value : undefined;
};

const findLayerOptions = (
  ast: t.File,
  source: string,
): { on?: number; off?: { start: number; end: number } } => {
  let on: number | undefined;
  let off: { start: number; end: number } | undefined;
  for (const object of pluginOptionObjects(ast, source))
    for (const node of object.properties) {
      const option = booleanLayerOption(node);
      if (option === undefined) continue;
      const { start, end, value } = option;
      if (typeof start !== "number" || typeof end !== "number") continue;
      if (value) on = start;
      else off = { start, end };
    }
  return { on, off };
};

const insideProject = (root: string, file: string | undefined): string | undefined => {
  if (file === undefined) return undefined;
  const relative = path.relative(root, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : file;
};

export const findPluginConfig = (root: string): string | undefined =>
  fs
    .readdirSync(root)
    .filter(name => CONFIG_FILE.test(name))
    .map(name => path.join(root, name))
    .find(file => containsPlugin(fs.readFileSync(file, "utf8")));

const insertOption = (source: string): string | undefined => {
  const postcssEntry = POSTCSS_ENTRY.exec(source);
  if (postcssEntry) {
    const at = postcssEntry.index + postcssEntry[0].length;
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

export const enableCssLayers = (root: string): LayersOutcome => {
  const file = findPluginConfig(root);
  if (file === undefined) return { kind: "no-plugin" };
  const source = fs.readFileSync(file, "utf8");
  const ast = parseConfig(source);
  const { on, off } = findLayerOptions(ast, source);
  if (on !== undefined) return { kind: "already", file };
  const foundEntry = findEntryCss(root);
  const entry = insideProject(root, foundEntry);
  const config = entry === undefined ? insideProject(root, findConfig(root)) : undefined;
  if (entry === undefined)
    return { kind: config === undefined ? "unconfirmed-tailwind" : "tailwind-3", file };

  const next = off
    ? `${source.slice(0, off.start)}true${source.slice(off.end)}`
    : insertOption(source);
  if (next === undefined) return { kind: "add-by-hand", file };
  fs.writeFileSync(file, next);
  return { kind: "set", file };
};

export const checkEntryOrder = (root: string): EntryOutcome => {
  const found = findEntryCss(root);
  const file = insideProject(root, found);
  if (file === undefined) return undefined;
  const nodes = postcss.parse(fs.readFileSync(file, "utf8"), { from: file }).nodes;
  const directive = nodes.findIndex(node => node.type === "atrule" && node.name === "stylex");
  const tailwind = nodes.findIndex(
    node =>
      node.type === "atrule" &&
      node.name === "import" &&
      /^["']tailwindcss(?:["'/])/.test(node.params),
  );
  if (directive === -1) return { file, stylex: "missing" };
  return { file, stylex: directive > tailwind ? "after" : "before" };
};

const LAYERS_MESSAGE: Record<LayersOutcome["kind"], string> = {
  set: "useCSSLayers set to true — a third less CSS than the :not(#\\#) polyfill.",
  already: "useCSSLayers already true.",
  "add-by-hand": 'add useCSSLayers: true to the StyleX plugin options (setup.md, "Two settings").',
  "tailwind-3":
    'useCSSLayers left off — Tailwind 3 is unlayered and would beat layered StyleX (setup.md, "Two settings").',
  "unconfirmed-tailwind":
    "useCSSLayers left off — no Tailwind 4 CSS entry found; confirm the setup before enabling layers.",
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
