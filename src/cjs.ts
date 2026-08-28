const hasDefault = (mod: unknown): mod is { default: unknown } =>
  typeof mod === "object" && mod !== null && "default" in mod;

export const cjsDefault = (mod: unknown): unknown => (hasDefault(mod) ? mod.default : mod);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const canCarryExports = (v: unknown): v is Record<string, unknown> =>
  (typeof v === "object" && v !== null) || typeof v === "function";

export const requireExport = (
  mod: unknown,
  name: string,
  source: string,
): Record<string, unknown> => {
  for (const candidate of [mod, cjsDefault(mod)]) {
    if (canCarryExports(candidate) && typeof candidate[name] === "function") return candidate;
  }
  throw new Error(`${source} does not export ${name}(). Check the installed version.`);
};
