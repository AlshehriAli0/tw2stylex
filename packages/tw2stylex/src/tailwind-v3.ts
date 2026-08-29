import fs from "node:fs";

import postcss from "postcss";

import { cjsDefault, isRecord, requireExport } from "./cjs.ts";
import type { DesignSystem } from "./tailwind.ts";

type Context = {
  getClassOrder: (classes: string[]) => Array<[string, bigint | null]>;
  candidateRuleMap: Map<unknown, unknown>;
  offsets: { sort: (generated: unknown) => unknown };
};

type Compiler = (...args: unknown[]) => unknown;

const isCompiler = (v: unknown): v is Compiler => typeof v === "function";

const isContext = (v: unknown): v is Context =>
  isRecord(v) &&
  typeof v.getClassOrder === "function" &&
  v.candidateRuleMap instanceof Map &&
  isRecord(v.offsets) &&
  typeof v.offsets.sort === "function";

const isNode = (v: unknown): v is postcss.AnyNode => isRecord(v) && typeof v.type === "string";

const declaresSlotDefaults = (node: postcss.AnyNode): node is postcss.AtRule =>
  node.type === "atrule" && node.name === "defaults";

const nodesOf = (generated: unknown): postcss.AnyNode[] => {
  if (!Array.isArray(generated)) return [];
  return generated.map(pair => (Array.isArray(pair) ? pair[1] : undefined)).filter(isNode);
};

const slotDefaults = (context: Context): Map<string, string> => {
  const everyNode = [...context.candidateRuleMap.values()].flatMap(nodesOf);
  const defaults = new Map<string, string>();
  for (const rule of everyNode.filter(declaresSlotDefaults))
    rule.walkDecls(decl => {
      if (decl.prop.startsWith("--tw-")) defaults.set(decl.prop, decl.value);
    });
  return defaults;
};

const asCompiler = (value: unknown, name: string, source: string): Compiler => {
  if (!isCompiler(value)) throw new Error(`${source} does not expose ${name}().`);
  return value;
};

const parseCss = (file: string | undefined): postcss.Root =>
  file === undefined ? postcss.root() : postcss.parse(fs.readFileSync(file, "utf8"));

export const loadV3 = (
  req: NodeJS.Require,
  configPath: string,
  entryCss: string | undefined,
): DesignSystem => {
  const source = `tailwindcss at ${req.resolve("tailwindcss")}`;
  const named = (id: string, name: string): Compiler =>
    asCompiler(requireExport(req(id), name, source)[name], name, source);
  const defaultOf = (id: string, name: string): Compiler =>
    asCompiler(cjsDefault(req(id)), name, source);

  const createContext = named("tailwindcss/lib/lib/setupContextUtils", "createContext");
  const generateRules = named("tailwindcss/lib/lib/generateRules", "generateRules");
  const loadConfig = named("tailwindcss/lib/lib/load-config", "loadConfig");
  const resolveConfig = defaultOf("tailwindcss/resolveConfig", "resolveConfig");
  const expandApply = defaultOf("tailwindcss/lib/lib/expandApplyAtRules", "expandApplyAtRules");

  const projectCss = parseCss(entryCss);
  const context = createContext(resolveConfig(loadConfig(configPath)), [], projectCss);
  if (!isContext(context)) throw new Error(`${source} gave a context tw2sx cannot read.`);
  const expandApplyIn = asCompiler(expandApply(context), "expandApplyAtRules(context)", source);

  const cssFor = (candidate: string): string | null => {
    const inCascadeOrder = context.offsets.sort(generateRules(new Set([candidate]), context));
    const nodes = nodesOf(inCascadeOrder);
    if (nodes.length === 0) return null;
    const root = postcss.root({ nodes: nodes.map(node => node.clone()) });
    expandApplyIn(root);
    return root.toString();
  };

  return {
    candidatesToCss: candidates => candidates.map(cssFor),
    getClassOrder: candidates => context.getClassOrder(candidates),
    slotDefaults: slotDefaults(context),
    themeDefault: () => undefined,
  };
};
