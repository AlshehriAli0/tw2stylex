# tw2sx

Migrate Tailwind v4 to StyleX. Converts what it can prove; skips the rest and tells an agent
exactly what to do about each skip.

```
tw2sx plan src/components/ui
50 files · 347 usages · 126 converted · 221 skipped
MISMATCHES: 0

src/ui/button.tsx:12:5: skipped descendant-selector "[&_svg]:size-4": … fix: Style the child directly.

Skipped, in the order to work them:
  safe
    dropped-shorthand         27
    marker-class              20
  needs-lookup
    parent-state             104
    descendant-selector       89
  check-first
    passed-in-classes        154

Full report: .tw2sx/plan-3d35e4.json
Next: tw2sx skipped .tw2sx/plan-3d35e4.json --fix safe --limit 20
```

## Why another one

Three Tailwind→StyleX converters exist. All three resolve classes through the real Tailwind
compiler — that part is settled prior art. All three also:

- bundle their own `theme.css`, so your `@theme`, `@utility` and `@plugin` are invisible and
  your tokens silently resolve to stock Tailwind values;
- name style keys `$1`, `$2`, `$3`;
- and **fail silently** — unknown classes, `space-y-*`, `group-*` and `[&_svg]:` simply vanish
  from the output with no diagnostic.

Since Tailwind and StyleX are not isomorphic, a partial conversion is the only honest outcome.
So the skips *are* the product: a typed, enumerable list of exactly what a human or an agent
still has to decide, with a recipe for each.

## Commands

| | |
|---|---|
| `tw2sx explain "<classes>"` | Resolve a class string to a StyleX object. Touches nothing. |
| `tw2sx plan <path>` | Scan, convert, verify. Writes a JSON report. **Never edits code.** |
| `tw2sx apply <path>` | Rewrite the sites that convert cleanly. Dry run unless `--write`. |
| `tw2sx skipped <report.json>` | Re-read a report, filtered by `--reason` / `--fix`. |

Exit codes: `0` clean · `1` completed with skips · `2` usage · `3` precondition · `10` internal.

## How it works

1. **Resolve.** Load the project's *own* entry CSS through `__unstable__loadDesignSystem`, so
   `@theme`, `@utility`, `@custom-variant`, `@plugin` and `@config` are all in scope.
2. **Order.** Sort the element's classes by `getClassOrder()` — Tailwind resolves conflicts by
   stylesheet order, not by position in the class attribute. `p-4 p-2` keeps `p-4`; `twMerge`
   would answer `p-2`.
3. **Reshape.** Resolve the element's whole class set together, expand Tailwind's `--tw-*`
   composition chains to literals (so `shadow-md ring-2` becomes one `box-shadow`), and turn
   variants into StyleX condition objects.
4. **Verify.** Compile the generated `stylex.create` through the real StyleX Babel plugin and
   compare declaration sets against Tailwind's. A mismatch is a hard failure.
5. **Report.** Everything unproven becomes a typed `Skip` with a reason, an fix,
   a location, and a hint.

## Skips

Each carries a **reason** (why it was skipped) and a **fix** (how hard it is to resolve):
`safe`, `needs-lookup`, `check-first`, `unknown`.

Reasons: `unknown-class`, `marker-class`, `descendant-selector`, `parent-state`,
`sibling-state`, `styles-children`, `dropped-shorthand`, `unresolved-variable`,
`unsupported-at-rule`, `dynamic-classes`, `variant-function`, `passed-in-classes`,
`lost-condition`, `two-style-sources`, `stylex-compile-error`.

The list is fixed, and [`skill/references/reason-codes.md`](skill/references/reason-codes.md)
has one hand-migration recipe per code.
[`skill/references/tokens.md`](skill/references/tokens.md) covers `@theme` → StyleX tokens, the
`--` variable bridge, and dark mode.

## The agent skill

[`skill/SKILL.md`](skill/SKILL.md) drives the CLI and teaches the agent to work the skips.
Its central rule is the StyleX landmine that silently breaks migrations:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is GONE. No error.
```

The skill's answer is to make that a compile error via `StyleXStylesWithout`, so a component
bans the properties it owns from its own style prop.

## Status

Verified against a real Tailwind v4 app (970 files, 7,125 usages): **5,563 converted with zero
mismatches**, in ~3s, byte-identical output between Node and Bun. `plan` and `apply` agree on
what converts, so the report never promises something `apply` will skip.

`__unstable__loadDesignSystem` is exactly as unstable as it sounds — pin your Tailwind version.

### Findings worth knowing, all reproduced against `@stylexjs/babel-plugin@0.19.0`

- **Cross-file `defineConsts` is broken** (facebook/stylex#1825). A shared breakpoint const
  emits `var(--x130wd72){…}` — an invalid at-rule, silently. Several published StyleX skills
  recommend exactly this pattern. Inline breakpoint strings per file until it is fixed.
- **`@container` *does* work** (anonymous and named), contrary to some circulating guidance.
- **The `--` literal-key bridge works**: `defineVars({'--background': …})` emits that exact
  variable name, so StyleX and escape-hatch CSS can share one definition.
- **`light-dark()`** works as a plain value and is usually simpler than `createTheme`.
