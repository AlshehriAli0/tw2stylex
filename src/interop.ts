/**
 * Several dependencies tw2sx drives (tailwindcss, @stylexjs/babel-plugin, @babel/traverse)
 * ship CommonJS. Node's ESM interop nests their real export under `.default`; Bun hands it
 * over directly. Getting this wrong is silent - you end up passing the whole module where a
 * function was expected - so every unwrap goes through here.
 */

const hasDefault = (mod: unknown): mod is { default: unknown } =>
  typeof mod === "object" && mod !== null && "default" in mod;

/** The module's real export, whichever side of the interop we landed on. */
export const cjsDefault = (mod: unknown): unknown => (hasDefault(mod) ? mod.default : mod);

/** A type predicate, not an assertion - the strict lint config forbids narrowing casts. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/**
 * Anything that can carry named properties. A CommonJS `module.exports` is often a
 * *function* with the real exports hung off it (tailwindcss does exactly this), so a
 * plain object check silently misses them.
 */
const isPropertyBag = (v: unknown): v is Record<string, unknown> =>
  (typeof v === "object" && v !== null) || typeof v === "function";

/**
 * Pick whichever of `mod` / `mod.default` carries `name` as a callable.
 * Throws rather than returning something unusable, because a missing export here means the
 * dependency is the wrong major version and every later error would be a confusing symptom.
 */
export const requireExport = (
  mod: unknown,
  name: string,
  source: string,
): Record<string, unknown> => {
  for (const candidate of [mod, cjsDefault(mod)]) {
    if (isPropertyBag(candidate) && typeof candidate[name] === "function") return candidate;
  }
  throw new Error(`${source} does not export ${name}(). Check the installed version.`);
};
