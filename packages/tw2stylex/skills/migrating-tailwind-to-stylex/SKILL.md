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
- [ ] 2. Tokens and shared primitives in place before any component converts —
      [tokens.md](references/tokens.md). Every component references them, so converting first
      means converting twice.
- [ ] 3. `tw2sx plan <path>` — writes a report, edits nothing.
- [ ] 4. Read `MISMATCHES`. **At 0, continue. Above 0, stop and tell the user** —
      the tool generated StyleX that does not match Tailwind, which is a tw2sx bug.
- [ ] 5. Fix skips in fix order: every `safe`, then every `needs-lookup`, then every
      `check-first`, then every `unknown`.
- [ ] 6. `tw2sx plan <path>` again. Continue only when the skip count dropped and mismatches
      are still 0.
- [ ] 7. Repeat from 5 until every remaining skip is one you can name a reason for keeping.
- [ ] 8. Run the project's own typecheck and build. Both clean.
- [ ] 9. Load a page you changed and read one converted element's computed styles. This
      confirms StyleX is wired up and the styles arrive. `plan` already proved the conversion
      declaration by declaration, so spend the look on what you wrote by hand: hover states,
      dark mode, anything conditional.
- [ ] 10. Summarise: usages converted, skips resolved, and each skip you kept with why.

`tw2sx explain "<classes>"` prints the exact StyleX object for any class string and whether it
verified. Reach for it whenever you are about to write a value from memory.

Migrate **leaves first** — a component only after the components it renders. A StyleX child
inside a Tailwind parent is where cascade surprises live.

Watch the total, not only the skips. `tw2sx plan` over the whole source tree gives one usage
count; if it rises between sessions, Tailwind is still being written faster than you remove it.

## Finishing

The loop above runs per directory. The migration ends when that whole-tree count reaches zero.
Then take the scaffolding back out:

- [ ] Delete every `customClassName` bridge. Each surviving one is a Tailwind class still in
      the build — [component-api.md](references/component-api.md).
- [ ] Drop `className` and `style` DOM props from components that exposed them only so Tailwind
      callers could reach in. A `style` prop typed with `StyleXStylesWithout` stays.
- [ ] Flip `useCSSLayers` to `true` — [setup.md](references/setup.md).
- [ ] `grep -rn "var(--" src`: each variable it finds is a project token. Done when every one
      is defined outside Tailwind's `@theme` — [tokens.md](references/tokens.md).
- [ ] Remove `tailwindcss`, its entry CSS, and `tw2sx` from the project.

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

**A shorthand carrying a condition loses to a longhand of the same box.** StyleX gives
longhands ID-level specificity, so `paddingTop` beats `padding` under `:hover`, the reverse of
Tailwind. `tw2sx` catches this as `shorthand-beaten-by-longhand` rather than converting it, but
the same trap is yours to avoid in anything you write by hand.

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

A bare descendant or child selector is the one loud failure: `{'> *': …}` throws
`Invalid pseudo or at-rule.` at build time. The constraint behind it is narrower than "no
selectors":

> An element may **read** its surroundings to style itself. It may not style anything else.

Reading is wide open. Any condition key starting `:` or `@` is accepted, so `:where()` and
`:has()` can reach ancestors and siblings:

```js
opacity: { default: 1, ':where([data-disabled] *)': 0.5 }   // some ancestor is disabled
```

Expect a lint warning there; the CSS is correct. `stylex.when.*` is the tidier form of the same
idea — see `sibling-state` in [reason-codes.md](references/reason-codes.md).

Styling a *different* element is what has no StyleX form. Style that element directly instead.
When it is genuinely out of reach — a global selector, third-party DOM you do not render, an
`@font-face` — put the rule in a **CSS Module beside the component**. Scoped, explicit,
greppable later. Record each use in your summary.

## What good output looks like

The tool is correct, not tasteful. What it leaves for you, worth doing as you review each
file rather than in a pass of their own:

- **Rename the guessed names.** A style is named after its element's `id`, then `aria-label`,
  then tag: `billing`, `saveBilling`, `div2`. A tag-derived name says where, so call it what
  the element is: `card`, `label`, `icon`.
- **One entry per distinct style.** Elements with the same declarations share one `styles.x`.
  Before adding a style by hand, look for the entry that already says it and point the element
  at that.
- **Keep styles beside their markup.** An exported `stylex.create` cannot be dead-code
  eliminated, so every unused style in a shared styles module ships as CSS forever. That is
  nearly always why a migration ends with *more* CSS than the Tailwind it replaced.
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
