import postcss from "postcss";

import { cjsDefault, isRecord, requireExport } from "./cjs.ts";
import type { DesignSystem } from "./tailwind.ts";

type Context = {
  getClassOrder: (classes: string[]) => Array<[string, bigint | null]>;
  candidateRuleMap: Map<unknown, unknown>;
};

type Compiler = (...args: unknown[]) => unknown;

const isCompiler = (v: unknown): v is Compiler => typeof v === "function";

const isContext = (v: unknown): v is Context =>
  isRecord(v) && typeof v.getClassOrder === "function" && v.candidateRuleMap instanceof Map;

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

const compiler = (module: unknown, name: string, source: string): Compiler => {
  const value: unknown = requireExport(module, name, source)[name];
  if (!isCompiler(value)) throw new Error(`${source} does not expose ${name}().`);
  return value;
};

export const loadV3 = (req: NodeJS.Require, configPath: string): DesignSystem => {
  const source = `tailwindcss at ${req.resolve("tailwindcss")}`;
  const from = (id: string, name: string): Compiler => compiler(req(id), name, source);

  const createContext = from("tailwindcss/lib/lib/setupContextUtils", "createContext");
  const generateRules = from("tailwindcss/lib/lib/generateRules", "generateRules");
  const loadConfig = from("tailwindcss/lib/lib/load-config", "loadConfig");
  const resolveConfig = cjsDefault(req("tailwindcss/resolveConfig"));
  if (!isCompiler(resolveConfig)) throw new Error(`${source} does not expose resolveConfig().`);

  const context = createContext(resolveConfig(loadConfig(configPath)));
  if (!isContext(context)) throw new Error(`${source} gave a context tw2sx cannot read.`);

  const cssFor = (candidate: string): string | null => {
    const nodes = nodesOf(generateRules(new Set([candidate]), context));
    if (nodes.length === 0) return null;
    return postcss.root({ nodes: nodes.map(node => node.clone()) }).toString();
  };

  return {
    candidatesToCss: candidates => candidates.map(cssFor),
    getClassOrder: candidates => context.getClassOrder(candidates),
    slotDefaults: slotDefaults(context),
  };
};
