import fs from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";
import * as t from "@babel/types";

import { declarationsOf, IDENT, printCreate, type Style } from "./css-to-stylex.ts";
import type { Skip } from "./skip.ts";
import { nameIsTaken } from "./style-name.ts";

type Spec = { from: string; export: string; key: string };
type Token = Spec & { file: string; actual?: string };
export type Tokens = Map<string, Token>;

const isSpec = (value: unknown): value is Spec =>
  typeof value === "object" &&
  value !== null &&
  "from" in value &&
  typeof value.from === "string" &&
  "export" in value &&
  typeof value.export === "string" &&
  IDENT.test(value.export) &&
  "key" in value &&
  typeof value.key === "string" &&
  IDENT.test(value.key);

const propertyName = (key: t.Expression | t.PrivateName): string | undefined => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  return undefined;
};

const constObject = (declaration: t.VariableDeclarator): t.ObjectExpression | undefined => {
  const call = declaration.init;
  if (
    !t.isCallExpression(call) ||
    !t.isMemberExpression(call.callee) ||
    !t.isIdentifier(call.callee.property, { name: "defineConsts" })
  )
    return undefined;
  const first = call.arguments[0];
  const object =
    t.isTSSatisfiesExpression(first) || t.isTSAsExpression(first) ? first.expression : first;
  return t.isObjectExpression(object) ? object : undefined;
};

const constValues = (file: string): Map<string, string> => {
  const values = new Map<string, string>();
  if (!fs.existsSync(file)) return values;
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(fs.readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    return values;
  }
  for (const statement of ast.program.body) {
    if (!t.isExportNamedDeclaration(statement) || !t.isVariableDeclaration(statement.declaration))
      continue;
    for (const declaration of statement.declaration.declarations) {
      if (!t.isIdentifier(declaration.id)) continue;
      const object = constObject(declaration);
      if (!object) continue;
      for (const property of object.properties) {
        if (!t.isObjectProperty(property) || property.computed) continue;
        const key = propertyName(property.key);
        if (key && t.isStringLiteral(property.value))
          values.set(`${declaration.id.name}\0${key}`, property.value.value);
      }
    }
  }
  return values;
};

export const loadTokens = (config: string): Tokens => {
  const parsed: unknown = JSON.parse(fs.readFileSync(config, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Invalid token mapping in ${config}: expected a CSS-value object.`);
  const tokens: Tokens = new Map();
  const files = new Map<string, Map<string, string>>();
  for (const [value, spec] of Object.entries(parsed)) {
    if (!isSpec(spec)) throw new Error(`Invalid token mapping for ${value} in ${config}.`);
    const file = path.resolve(path.dirname(config), spec.from);
    let values = files.get(file);
    if (!values) {
      values = constValues(file);
      files.set(file, values);
    }
    tokens.set(value, { ...spec, file, actual: values.get(`${spec.export}\0${spec.key}`) });
  }
  return tokens;
};

export const tokenSkips = (style: Style, tokens: Tokens | undefined): Skip[] => {
  if (!tokens?.size) return [];
  const skips: Skip[] = [];
  for (const { value } of declarationsOf(style)) {
    if (typeof value !== "string") continue;
    const token = tokens.get(value);
    if (!token || token.actual === value) continue;
    skips.push({
      reason: "token-needs-verification",
      detail: `${token.export}.${token.key} is ${token.actual ?? "unresolved"}; the checked declaration is ${value}.`,
      hint: "Use an exact defineConsts value or verify and migrate this declaration by hand.",
    });
  }
  return skips;
};

type SourceOptions = {
  styles: Record<string, Style>;
  tokens?: Tokens;
  file: string;
  code: string;
  objectName?: string;
  stylex?: string;
};

export const mappedSource = ({
  styles,
  tokens,
  file,
  code,
  objectName = "styles",
  stylex = "stylex",
}: SourceOptions): { source: string; imports: string[] } => {
  if (!tokens?.size) return { source: printCreate(styles, objectName, stylex), imports: [] };
  const replacements = new Map<string, string>();
  const modules = new Map<string, string>();
  const imports: string[] = [];
  const taken = nameIsTaken(code);
  let nextAlias = 1;
  for (const style of Object.values(styles))
    for (const { value } of declarationsOf(style)) {
      if (typeof value !== "string") continue;
      const token = tokens?.get(value);
      if (!token || token.actual !== value) continue;
      let alias = modules.get(token.file);
      if (!alias) {
        while (taken(`tw2stylexToken${nextAlias}`)) nextAlias += 1;
        alias = `tw2stylexToken${nextAlias++}`;
        modules.set(token.file, alias);
        const relative = path.relative(path.dirname(file), token.file).replace(/\.[jt]sx?$/, "");
        const from = relative.startsWith(".") ? relative : `./${relative}`;
        imports.push(`import * as ${alias} from ${JSON.stringify(from)};`);
      }
      replacements.set(value, `${alias}.${token.export}.${token.key}`);
    }
  return { source: printCreate(styles, objectName, stylex, replacements), imports };
};
