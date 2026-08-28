---
name: migrating-tailwind-to-stylex
description: >-
  Migrates Tailwind v4 to StyleX with the tw2sx CLI and hand-resolves the sites it refuses.
  Use when moving a codebase off Tailwind, when StyleX or tw2sx is mentioned, when converting
  className strings or cva() variant maps, or when working a tw2sx report's refusals.
---

# Migrating Tailwind to StyleX

`tw2sx` resolves each Tailwind class through the project's own compiler and converts it only
when it can prove the CSS declarations come out identical. What it cannot prove, it **refuses**
and reports. The refusals are your work.

Pixels must not change. A style you cannot convert stays in the file and goes into your summary.

## The loop

- [ ] 1. `tw2sx plan <path>` — writes a report, edits nothing.
- [ ] 2. Read `DECLARATION MISMATCHES`. **At 0, continue. Above 0, stop and tell the user** —
      the tool generated StyleX that does not match Tailwind, which is a tw2sx bug.
- [ ] 3. Fix refusals in applicability order: every `machine-applicable` one, then every
      `has-placeholders` one, then every `maybe-incorrect` one.
- [ ] 4. `tw2sx plan <path>` again. Continue only when the refusal count dropped and mismatches
      are still 0.
- [ ] 5. Repeat from 3 until every remaining refusal is one you can name a reason for keeping.
- [ ] 6. Summarise: sites converted, refusals resolved, and each refusal you kept with why.

`tw2sx explain "<classes>"` prints the exact StyleX object for any class string and whether it
verified. Reach for it whenever you are about to write a value from memory.

Migrate **leaves first** — a component only after the components it renders. A StyleX child
inside a Tailwind parent is where cascade surprises live.

## Reading a refusal

```
src/ui/Card.tsx:41:18: refused descendant-selector "[&_svg]:size-4": … help: Style the child directly.
```

**reason** says why it was refused; **applicability** says what you do about it:

| applicability | your move |
|---|---|
| `machine-applicable` | One right answer. Batch these. |
| `has-placeholders` | Go find what the tool could not — an ancestor, a child component. |
| `maybe-incorrect` | A rewrite exists but shifts behaviour at the edges. Read the surrounding code first. |
| `unspecified` | Investigate. Often not a Tailwind class at all. |

Filter with `tw2sx refusals <report.json> --reason <r> --applicability <a>`.

## Silent failure is the house style

StyleX rejects most of what it dislikes by rendering nothing — no error, no warning, just a
style that is gone. Every rule below exists because breaking it is **silent**, so confirm your
edits by re-running `tw2sx plan`.

**Erasure — one flat value destroys every condition on that property.** StyleX merges per
property, not per property-per-state. The most dangerous difference from Tailwind:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is gone.
```

Make erasure a compile error instead of a habit — see [component-api.md](references/component-api.md).

**Twelve shorthands compile to nothing.** `background`, `border`, `animation`, `all`,
`borderTop`/`Right`/`Bottom`/`Left`, `borderInline`/`Block`(`Start`/`End`). Write longhands:
`backgroundColor`, `borderWidth`+`borderStyle`+`borderColor`, `animationName`+`animationDuration`.
These shorthands are fine: `margin`, `padding`, `inset`, `flex`, `transition`, `font`,
`gridArea`, `borderRadius`, `outline`.

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
  `contract-change`, `cva-call`, or any component that accepts styling from callers.
- [tokens.md](references/tokens.md) — `@theme` → StyleX tokens, the `--` variable bridge, dark
  mode. Read it before touching tokens or theming.
