/**
 * A tiny typed reader over `process.argv`. The point is that every command reads flags
 * through accessors that already know the type, so no command body needs a cast.
 */
export type Flag = string | boolean;

export type Args = {
  /** Positional arguments, command name first. */
  positional: string[];
  flags: Map<string, Flag>;
};

export const parseArgs = (argv: string[]): Args => {
  const positional: string[] = [];
  const flags = new Map<string, Flag>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }

  return { positional, flags };
};

/** The flag's value when it was given a string, otherwise undefined. */
export const flagString = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

/** True when the flag was passed at all, with or without a value. */
export const flagPresent = (args: Args, name: string): boolean => args.flags.has(name);

/** True only for a bare `--name` with no value attached. */
export const flagBare = (args: Args, name: string): boolean => args.flags.get(name) === true;

export const flagNumber = (args: Args, name: string, fallback: number): number => {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const positionalAt = (args: Args, index: number): string | undefined =>
  args.positional[index];
