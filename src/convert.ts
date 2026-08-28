import { checkStyle, type Mismatch } from "./check.ts";
import { resolveClasses } from "./classes-to-css.ts";
import { printCreate, toStyle, type Style } from "./css-to-stylex.ts";
import type { Skip } from "./skip.ts";
import type { DesignSystem } from "./tailwind.ts";

export type Converted =
  | { style: Style; source: string; rules: number; skips: []; mismatches: [] }
  | { style?: undefined; source?: undefined; rules: 0; skips: Skip[]; mismatches: Mismatch[] };

const nothing = (skips: Skip[], mismatches: Mismatch[] = []): Converted => ({
  rules: 0,
  skips,
  mismatches,
});

const lastLine = (message: string): string => message.split("\n").pop()?.trim() ?? message;

export const convert = (ds: DesignSystem, name: string, classes: string[]): Converted => {
  const resolved = resolveClasses(ds, classes);
  if (resolved.skips.length > 0) return nothing(resolved.skips);
  if (resolved.declarations.size === 0) return nothing([]);

  const style = toStyle(resolved);
  const checked = checkStyle(name, resolved, style);

  if (checked.ok)
    return {
      style,
      source: printCreate({ [name]: style }),
      rules: checked.rules.length,
      skips: [],
      mismatches: [],
    };

  if (checked.kind === "compile-error")
    return nothing([
      {
        reason: "stylex-compile-error",
        detail: `The StyleX we generated does not compile: ${lastLine(checked.message)}`,
        hint: "This is a tw2sx bug. Convert this one by hand and please report it.",
      },
    ]);

  return nothing(
    [
      {
        reason: "lost-condition",
        detail: `The StyleX we generated differs from Tailwind in ${checked.mismatches.length} place(s).`,
        hint: "See `mismatches` in the JSON report. This is a tw2sx bug; convert this one by hand.",
      },
    ],
    checked.mismatches,
  );
};
