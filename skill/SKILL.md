---
name: migrating-tailwind-to-stylex
description: >-
  Migrates Tailwind v4 to StyleX with the tw2sx CLI and hand-resolves the usages it skips.
  Use when moving a codebase off Tailwind, when StyleX or tw2sx is mentioned, when converting
  className strings or cva() variant maps, or when working a tw2sx report's skips.
---

# Migrating Tailwind to StyleX

`tw2sx` resolves each Tailwind class through the project's own compiler and converts it only
when it can prove the CSS declarations come out identical. What it cannot prove, it **skips**
and reports. The skips are your work.

Pixels must not change. A style you cannot convert stays in the file and goes into your summary.

## The loop

- [ ] 1. `tw2sx plan <path>` — writes a report, edits nothing.
- [ ] 2. Read `MISMATCHES`. **At 0, continue. Above 0, stop and tell the user** —
      the tool generated StyleX that does not match Tailwind, which is a tw2sx bug.
- [ ] 3. Fix skips in fix order: every `safe` one, then every
      `needs-lookup` one, then every `check-first` one.
- [ ] 4. `tw2sx plan <path>` again. Continue only when the skip count dropped and mismatches
      are still 0.
- [ ] 5. Repeat from 3 until every remaining skip is one you can name a reason for keeping.
- [ ] 6. Summarise: usages converted, skips resolved, and each skip you kept with why.

`tw2sx explain "<classes>"` prints the exact StyleX object for any class string and whether it
verified. Reach for it whenever you are about to write a value from memory.

Migrate **leaves first** — a component only after the components it renders. A StyleX child
inside a Tailwind parent is where cascade surprises live.

## Reading a skip

```
src/ui/Card.tsx:41:18: skipped descendant-selector "[&_svg]:size-4": … help: Style the child directly.
```

**reason** says why it was skipped; **fix** says what you do about it:

| fix | your move |
|---|---|
| `safe` | One right answer. Batch these. |
| `needs-lookup` | Go find what the tool could not — an ancestor, a child component. |
| `check-first` | A rewrite exists but shifts behaviour at the edges. Read the surrounding code first. |
| `unknown` | Investigate. Often not a Tailwind class at all. |

Filter with `tw2sx skipped <report.json> --reason <r> --fix <a>`.

## Silent failure is the house style

StyleX rejects most of what it dislikes by rendering nothing — no error, no warning, just a
style that is gone. Every rule below exists because breaking it is **silent**, so confirm your
edits by re-running `tw2sx plan`.

**Overwriting a property wipes every condition on it.** StyleX merges per
property, not per property-per-state. The most dangerous difference from Tailwind:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is gone.
```

Make this a compile error instead of a thing you remember — see [component-api.md](references/component-api.md).

**Fourteen shorthands compile to nothing.** `background`, `border`, `animation`, `all`, and every
directional border — `borderTop`/`Right`/`Bottom`/`Left`,
`borderInline`/`Block`/`InlineStart`/`InlineEnd`/`BlockStart`/`BlockEnd`. Each skip's hint names
the longhands to write. These stay whole: `margin`, `padding`, `inset`, `flex`, `transition`,
`font`, `gridArea`, `borderRadius`, `outline`.

**There is no `!important`.** `stylex.props()` argument order is the precedence rule: later wins.

**`default` is required on any property carrying a condition.** Use `null` when there is no
base value. Without it the condition never applies.

**`stylex.props()` styles host elements only.** Spread onto `<MyCard>` it does nothing to that
component's DOM — pass the styles through a `style` prop and let the component apply them to
its own `<div>`.

**One styling source per element.** An element spreading `stylex.props()` carries no separate
`className` or `style` attribute; whichever is written second wins.

**Import `.stylex.ts` files directly.** A barrel re-export loses them to static analysis.

**Keyframes are file-local.** `stylex.keyframes()`, never a raw `@keyframes` string. Share one
across files by wrapping its name in a `defineVars` token.

Descendant and child selectors are the one loud failure: `{'> *': …}` throws
`Invalid pseudo or at-rule.` at build time.

## Before the first conversion

**Set `useCSSLayers: false` while Tailwind is still in the build.** Tailwind v4 puts utilities
in `@layer utilities`, and unlayered CSS beats layered CSS. With layers on, StyleX loses to the
Tailwind you have not deleted and migrated components keep their old styles. Flip it to `true`
after the last Tailwind class is gone.

**Prove the plugin is wired.** Style one `<div>`, check its computed styles. Without the build
integration `stylex.props()` returns nothing and every style vanishes — which looks exactly
like a bad conversion and is not one.

## References

Each is one hop. Reach for them by name.

- [reason-codes.md](references/reason-codes.md) — one recipe per reason code. Read the section
  for any reason you have not yet handled this session.
- [component-api.md](references/component-api.md) — the `style` prop contract, banning owned
  properties at the type level, converting `cva`, the `className` bridge. Read it for
  `passed-in-classes`, `variant-function`, or any component that accepts styling from callers.
- [tokens.md](references/tokens.md) — `@theme` → StyleX tokens, the `--` variable bridge, dark
  mode. Read it before touching tokens or theming.
