export type Flag = string | boolean;

export type Args = {
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

export const flagString = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

export const flagWasPassed = (args: Args, name: string): boolean => args.flags.has(name);

export const flagWithoutValue = (args: Args, name: string): boolean =>
  args.flags.get(name) === true;

export const flagNumber = (args: Args, name: string, fallback: number): number => {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const positionalAt = (args: Args, index: number): string | undefined =>
  args.positional[index];
