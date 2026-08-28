import { printCreate, toStyle, type Style } from "./emit.ts";
import { resolveClasses } from "./reshape.ts";
import type { DesignSystem } from "./resolve.ts";
import type { Skip } from "./skip.ts";
import { checkStyle, type Mismatch } from "./verify.ts";

/**
 * Turning a list of Tailwind classes into a checked StyleX style, in one place.
 *
 * Every caller used to write these four steps by hand, and they drifted: `plan` counted a
 * usage as converted when `apply` would skip it, which broke ADR-0002's "never partially
 * converts a usage" for 14% of the sites in a real codebase. The rule now lives here only.
 */
export type Converted = {
  /** Set when the classes converted cleanly and nothing was skipped. */
  style?: Style;
  /** `stylex.create` source for `style`, ready to write. */
  source?: string;
  /** Everything we did not convert. Non-empty means `style` is undefined. */
  skips: Skip[];
  /** Non-empty means our output disagrees with Tailwind - always our bug. */
  mismatches: Mismatch[];
  /** How many atomic CSS rules StyleX produced. Zero when nothing converted. */
  rules: number;
};

/**
 * ADR-0002: convert only what we can prove. A usage converts when every class resolved,
 * nothing was skipped, and the generated StyleX compiles to the same declarations Tailwind
 * produced. Anything less and the caller gets skips instead of a style.
 */
export const convert = (ds: DesignSystem, name: string, classes: string[]): Converted => {
  const resolved = resolveClasses(ds, classes);
  const empty = { skips: resolved.skips, mismatches: [], rules: 0 };

  if (resolved.skips.length > 0 || resolved.declarations.size === 0) return empty;

  const style = toStyle(resolved);
  const checked = checkStyle(name, resolved, style);

  if (checked.ok) {
    return {
      style,
      source: printCreate({ [name]: style }),
      skips: [],
      mismatches: [],
      rules: checked.rules.length,
    };
  }

  if (checked.kind === "compile-error") {
    return {
      ...empty,
      skips: [
        {
          reason: "stylex-compile-error",
          detail: `The StyleX we generated does not compile: ${lastLine(checked.message)}`,
          hint: "This is a tw2sx bug. Convert this one by hand and please report it.",
        },
      ],
    };
  }

  return {
    ...empty,
    mismatches: checked.mismatches,
    skips: [
      {
        reason: "lost-condition",
        detail: `The StyleX we generated differs from Tailwind in ${checked.mismatches.length} place(s).`,
        hint: "See `mismatches` in the JSON report. This is a tw2sx bug; convert this one by hand.",
      },
    ],
  };
};

const lastLine = (message: string): string => message.split("\n").pop()?.trim() ?? message;
