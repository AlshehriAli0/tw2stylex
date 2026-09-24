import fs from "node:fs";
import path from "node:path";

import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";

type Alias = { pattern: string; target: string };

const keyOf = (key: t.Expression | t.PrivateName): string | undefined => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  return undefined;
};

const propertyIn = (object: t.ObjectExpression, name: string): t.ObjectProperty | undefined =>
  object.properties.find(
    (property): property is t.ObjectProperty =>
      t.isObjectProperty(property) && !property.computed && keyOf(property.key) === name,
  );

const objectIn = (object: t.ObjectExpression, name: string): t.ObjectExpression | undefined => {
  const value = propertyIn(object, name)?.value;
  return t.isObjectExpression(value) ? value : undefined;
};

const configFor = (file: string): string | undefined => {
  let dir = path.dirname(path.resolve(file));
  while (true) {
    const config = path.join(dir, "tsconfig.json");
    if (fs.existsSync(config)) return config;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const aliasesFor = (file: string): Alias[] => {
  const config = configFor(file);
  if (!config) return [];
  let root: t.Expression;
  try {
    root = parseExpression(`(${fs.readFileSync(config, "utf8")})`);
  } catch {
    return [];
  }
  if (!t.isObjectExpression(root)) return [];
  const options = objectIn(root, "compilerOptions");
  const paths = options && objectIn(options, "paths");
  if (!paths) return [];
  const baseUrl = options && propertyIn(options, "baseUrl")?.value;
  const base = path.resolve(path.dirname(config), t.isStringLiteral(baseUrl) ? baseUrl.value : ".");
  return paths.properties.flatMap(property => {
    if (!t.isObjectProperty(property) || property.computed) return [];
    const pattern = keyOf(property.key);
    const first = t.isArrayExpression(property.value) ? property.value.elements[0] : undefined;
    return pattern && t.isStringLiteral(first)
      ? [{ pattern, target: path.resolve(base, first.value) }]
      : [];
  });
};

const aliasPath = (specifier: string, aliases: Alias[]): string | undefined => {
  for (const { pattern, target } of aliases) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier === pattern) return target;
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix))
      return target.replace("*", specifier.slice(prefix.length, specifier.length - suffix.length));
  }
  return undefined;
};

const existingSource = (base: string): string | undefined => {
  for (const candidate of [
    base,
    ...[".tsx", ".ts", ".jsx", ".js"].map(ext => base + ext),
    ...["index.tsx", "index.ts", "index.jsx", "index.js"].map(name => path.join(base, name)),
  ])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return undefined;
};

export const importResolver = (): ((caller: string, specifier?: string) => string) => {
  const aliasesByDir = new Map<string, Alias[]>();
  const sources = new Map<string, string>();
  return (caller, specifier): string => {
    if (!specifier) return "unresolved";
    const dir = path.dirname(caller);
    const key = `${dir}\0${specifier}`;
    const cached = sources.get(key);
    if (cached) return cached;
    let base: string | undefined;
    if (specifier.startsWith(".")) base = path.resolve(dir, specifier);
    else {
      let aliases = aliasesByDir.get(dir);
      if (!aliases) {
        aliases = aliasesFor(caller);
        aliasesByDir.set(dir, aliases);
      }
      base = aliasPath(specifier, aliases);
    }
    const source = (base && existingSource(base)) ?? `unresolved (${specifier})`;
    sources.set(key, source);
    return source;
  };
};
