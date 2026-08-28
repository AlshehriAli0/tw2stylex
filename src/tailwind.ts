import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { cjsDefault, isRecord, requireExport } from "./cjs.ts";

export type DesignSystem = {
  candidatesToCss: (classes: string[]) => Array<string | null>;
  getClassOrder: (classes: string[]) => Array<[string, bigint | null]>;
  resolveThemeValue: (path: string, forceInline?: boolean) => string | undefined;
};

export type LoadedSystem = { ds: DesignSystem; entry: string; base: string; version: string };

type PackageMeta = {
  exports?: unknown;
  style?: unknown;
  main?: unknown;
  version?: unknown;
};

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const splitSpecifier = (id: string): { pkg: string; rest: string } => {
  const parts = id.split("/");
  const nameLength = id.startsWith("@") ? 2 : 1;
  return { pkg: parts.slice(0, nameLength).join("/"), rest: parts.slice(nameLength).join("/") };
};

const cssFromExports = (entry: unknown): string | undefined => {
  if (typeof entry === "string") return entry.endsWith(".css") ? entry : undefined;
  if (!isRecord(entry)) return undefined;
  for (const key of ["style", "default", "import", "require"]) {
    const hit = cssFromExports(entry[key]);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const readPackageMeta = (root: string): PackageMeta => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return isRecord(parsed) ? parsed : {};
};

const firstExisting = (root: string, candidates: Array<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
};

type Resolver = {
  require: NodeJS.Require;
  packageRoot: (pkg: string) => string;
  resolveCss: (id: string, from: string) => string;
};

const makeResolver = (base: string): Resolver => {
  const req = createRequire(path.join(base, "__tw2sx__.js"));

  const inNodeModules = (pkg: string): string | undefined => {
    for (const dir of req.resolve.paths(pkg) ?? []) {
      const candidate = path.join(dir, pkg);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    return undefined;
  };

  const aboveMainEntry = (pkg: string): string | undefined => {
    let cur = path.dirname(req.resolve(pkg));
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, "package.json"))) return cur;
      const next = path.dirname(cur);
      if (next === cur) return undefined;
      cur = next;
    }
    return undefined;
  };

  const packageRoot = (pkg: string): string => {
    const root = inNodeModules(pkg) ?? aboveMainEntry(pkg);
    if (root === undefined) throw new Error(`cannot locate package "${pkg}" from ${base}`);
    return root;
  };

  const resolveRelative = (id: string, from: string): string => {
    const file = path.resolve(from, id);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return path.join(file, "index.css");
    if (!fs.existsSync(file) && fs.existsSync(`${file}.css`)) return `${file}.css`;
    return file;
  };

  const resolveSubpath = (root: string, meta: PackageMeta, rest: string): string => {
    const direct = path.join(root, rest);
    if (fs.existsSync(direct)) return direct;
    const exportsMap = isRecord(meta.exports) ? meta.exports : {};
    const viaExports = cssFromExports(exportsMap[`./${rest}`]);
    if (viaExports !== undefined) return path.join(root, viaExports);
    if (fs.existsSync(`${direct}.css`)) return `${direct}.css`;
    return direct;
  };

  const resolvePackageRootCss = (id: string, root: string, meta: PackageMeta): string => {
    const exportsMap = isRecord(meta.exports) ? meta.exports : {};
    const mainCss = asString(meta.main);
    const file = firstExisting(root, [
      cssFromExports(exportsMap["."]) ?? cssFromExports(meta.exports),
      asString(meta.style),
      mainCss?.endsWith(".css") === true ? mainCss : undefined,
      "index.css",
    ]);
    if (file === undefined) throw new Error(`no stylesheet found for "${id}" (looked in ${root})`);
    return file;
  };

  const resolveCss = (id: string, from: string): string => {
    if (id.startsWith(".") || path.isAbsolute(id)) return resolveRelative(id, from);
    const { pkg, rest } = splitSpecifier(id);
    const root = packageRoot(pkg);
    const meta = readPackageMeta(root);
    return rest ? resolveSubpath(root, meta, rest) : resolvePackageRootCss(id, root, meta);
  };

  return { require: req, packageRoot, resolveCss };
};

type LoadDesignSystemFn = (
  css: string,
  opts: {
    base: string;
    loadStylesheet: (
      id: string,
      from: string,
    ) => Promise<{ path: string; base: string; content: string }>;
    loadModule: (
      id: string,
      from: string,
      kind: string,
    ) => Promise<{ path: string; base: string; module: unknown }>;
  },
) => Promise<DesignSystem>;

const isLoadDesignSystem = (v: unknown): v is LoadDesignSystemFn => typeof v === "function";

export const loadDesignSystem = async (entryCssPath: string): Promise<LoadedSystem> => {
  const entry = path.resolve(entryCssPath);
  if (!fs.existsSync(entry)) throw new Error(`entry CSS not found: ${entry}`);
  const base = path.dirname(entry);
  const { require: req, packageRoot, resolveCss } = makeResolver(base);

  const twPath = req.resolve("tailwindcss");
  const twMod: unknown = await import(twPath);
  const tw = requireExport(twMod, "__unstable__loadDesignSystem", `tailwindcss at ${twPath}`);
  const load = tw.__unstable__loadDesignSystem;
  if (!isLoadDesignSystem(load)) throw new Error(`tailwindcss at ${twPath} is not a v4 build.`);

  const version = asString(readPackageMeta(packageRoot("tailwindcss")).version) ?? "unknown";

  const loadStylesheet = async (
    id: string,
    from: string,
  ): Promise<{ path: string; base: string; content: string }> => {
    const file = resolveCss(id, from);
    return await Promise.resolve({
      path: file,
      base: path.dirname(file),
      content: fs.readFileSync(file, "utf8"),
    });
  };

  const loadModule = async (
    id: string,
    from: string,
  ): Promise<{ path: string; base: string; module: unknown }> => {
    const file =
      id.startsWith(".") || path.isAbsolute(id) ? path.resolve(from, id) : req.resolve(id);
    const mod: unknown = await import(file);
    return { path: file, base: path.dirname(file), module: cjsDefault(mod) };
  };

  const ds = await load(fs.readFileSync(entry, "utf8"), { base, loadStylesheet, loadModule });
  return { ds, entry, base, version };
};
