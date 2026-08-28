---
name: migrating-tailwind-to-stylex
description: >-
  Migrates Tailwind to StyleX with the tw2sx CLI, then hand-resolves what it skips.
  Use when moving code off Tailwind, when working a tw2sx report, when installing StyleX
  into a build, or when writing StyleX styles by hand.
---

# Migrating Tailwind to StyleX

`tw2sx` resolves each Tailwind class through the project's own compiler and converts it only
when it can prove the CSS declarations come out identical. What it cannot prove, it **skips**
and reports. The skips are your work.

Pixels stay identical. A style you cannot convert stays in the file and goes into your summary.

## The loop

- [ ] 0. `tw2sx init` — installs this skill into the project. Run it when the `version` in this
      file's frontmatter differs from `tw2sx --version`: the copy you are reading came from an
      older tw2sx and may name reasons or a fix order the tool no longer uses.
- [ ] 1. StyleX installed and proven to render — [setup.md](references/setup.md). Once per project.
- [ ] 2. `tw2sx plan <path>` — writes a report, edits nothing.
- [ ] 3. Read `MISMATCHES`. **At 0, continue. Above 0, stop and tell the user** —
      the tool generated StyleX that does not match Tailwind, which is a tw2sx bug.
- [ ] 4. Fix skips in fix order: every `safe`, then every `needs-lookup`, then every
      `check-first`, then every `unknown`.
- [ ] 5. `tw2sx plan <path>` again. Continue only when the skip count dropped and mismatches
      are still 0.
- [ ] 6. Repeat from 4 until every remaining skip is one you can name a reason for keeping.
- [ ] 7. Run the project's own typecheck and build. Both clean.
- [ ] 8. Load a page you changed and read one converted element's computed styles.
      Typechecking proves the code is valid; only this proves it still renders.
- [ ] 9. Summarise: usages converted, skips resolved, and each skip you kept with why.

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

StyleX rejects most of what it dislikes by rendering nothing: the style is simply gone. Every
rule below is **silent** when broken, so confirm your edits by re-running `tw2sx plan`.

**Overwriting a property wipes every condition on it.** StyleX merges per
property, not per property-per-state. The most dangerous difference from Tailwind:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is gone.
```

Make this a compile error instead of a thing you remember — see [component-api.md](references/component-api.md).

**These shorthands compile to nothing.** `background`, `border`, `animation`, `all`, and every
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

**One styling source per element.** The `stylex.props()` spread is the element's only styling
attribute; where a `className` or `style` sits beside it, whichever is written second wins.

**Conditions nest inside a property value.** A `:hover` or `@media` key at the top level of a
style object is the single most common StyleX mistake:

```js
// gone: nothing renders
button: { ':hover': { backgroundColor: 'blue' } }
// right
button: { backgroundColor: { default: 'lightblue', ':hover': 'blue' } }
```

**Every value in `stylex.create` is a literal or a StyleX token.** An imported plain constant
(`import { PADDING } from './constants'`) is not statically analysable and the property is
dropped. Move the value into a `.stylex.ts` `defineVars`/`defineConsts`, or inline it.

**Import `.stylex.ts` files directly.** A barrel re-export loses them to static analysis.

**Keyframes are file-local.** Define them with `stylex.keyframes()`. Share one across files by
wrapping its name in a `defineVars` token.

Descendant and child selectors are the one loud failure: `{'> *': …}` throws
`Invalid pseudo or at-rule.` at build time.

## What good output looks like

The tool is correct, not tasteful. Three things it leaves for you, worth doing as you review
each file rather than in a pass of their own:

- **Rename the placeholders.** `el1`, `el2` are positions, not names. Call them what the element
  is — `card`, `label`, `icon`.
- **Keep styles beside their markup.** Co-location is the point of StyleX; resist collecting a
  file's styles into a shared module.
- **Reach for a token before a literal.** A repeated `16` that the project already spells
  `spacing.medium` should say so — see [tokens.md](references/tokens.md).

## References

- [reason-codes.md](references/reason-codes.md) — one recipe per reason code. Read the section
  for any reason you have not yet handled this session.
- [component-api.md](references/component-api.md) — the `style` prop contract, banning owned
  properties at the type level, converting `cva`, the `className` bridge. Read it for
  `passed-in-classes`, `variant-function`, or any component that accepts styling from callers.
- [tokens.md](references/tokens.md) — `@theme` → StyleX tokens, the `--` variable bridge, dark
  mode. Read it before touching tokens or theming.
- [setup.md](references/setup.md) — installing StyleX, wiring the build, the CSS entrypoint,
  `useCSSLayers`, proving it renders. Read it before the first conversion in a project, or when
  a converted component renders unstyled.

Facebook publishes two files written for agents —
[authoring](https://raw.githubusercontent.com/facebook/stylex/main/packages/docs/static/llm/stylex-authoring.md)
and [installation](https://raw.githubusercontent.com/facebook/stylex/main/packages/docs/static/llm/stylex-installation.md).
Fetch them for any API this skill does not cover, and to check a rule here that looks wrong.
