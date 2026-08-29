---
name: migrating-tailwind-to-stylex
description: >-
  Migrates Tailwind to StyleX with the tw2stylex CLI, then hand-resolves what it skips. Read in
  full before the first tw2stylex command. Use when moving code off Tailwind, when a tw2stylex report
  or skip is in front of you, when installing StyleX into a build, when writing StyleX
  styles by hand, or when the CSS bundle grew after converting.
---

# Migrating Tailwind to StyleX

`tw2stylex` resolves each Tailwind class through the project's own compiler and converts it only
when it can prove the CSS declarations come out identical. What it cannot prove, it **skips**
and reports. The skips are your work.

Pixels stay identical.

## The loop

- [ ] 0. `tw2stylex init` — installs this skill into the project. Run it when the `version` in this
      file's frontmatter differs from `tw2stylex --version`: the copy you are reading came from an
      older tw2stylex and may name reasons or a fix order the tool no longer uses.
- [ ] 1. Read three pages to their last line, once per project, before any other step:
      [Thinking in StyleX](https://stylexjs.com/docs/learn/thinking-in-stylex), and Facebook's
      two files written for agents —
      [authoring](https://raw.githubusercontent.com/facebook/stylex/main/packages/docs/static/llm/stylex-authoring.md)
      and
      [installation](https://raw.githubusercontent.com/facebook/stylex/main/packages/docs/static/llm/stylex-installation.md).
      They are the model this skill assumes; every rule below is a corollary. Done when you can
      say, without looking, why StyleX has no descendant selectors.
- [ ] 2. StyleX installed and proven to render — [setup.md](references/setup.md). Once per project.
      Then `tw2stylex init` again, now that it can see the plugin. Done when it reports
      `useCSSLayers` set, or names the reason it left it off.
- [ ] 3. Tokens and shared primitives in place before any component converts —
      [tokens.md](references/tokens.md). Every component references them, so converting first
      means converting twice.
- [ ] 4. `tw2stylex plan <path>` — writes a report, edits nothing.
- [ ] 5. Read `MISMATCHES`. **At 0, continue. Above 0, stop and tell the user** —
      the tool generated StyleX that does not match Tailwind, which is a tw2stylex bug.
- [ ] 6. Fix skips in fix order: every `safe`, then every `needs-lookup`, then every
      `check-first`, then every `unknown` — each by its recipe in
      [reason-codes.md](references/reason-codes.md), read before the first skip of that reason.
- [ ] 7. `tw2stylex plan <path>` again. Continue only when the skip count dropped and mismatches
      are still 0.
- [ ] 8. Repeat from 6 until every remaining skip is one you can name a reason for keeping.
- [ ] 9. Run the project's own typecheck and build. Both clean.
- [ ] 10. Screenshot-diff every changed route, in every theme the app has, against the last
      Tailwind commit (`git worktree add ../before <commit>`, build both). `plan` proved the
      converted usages; the ones you resolved by hand have only this check. Done when the diff is
      zero, or every difference is one you can name.
- [ ] 11. Summarise: usages converted, skips resolved, and each skip you kept with why.

`tw2stylex explain "<classes>"` prints the exact StyleX object for any class string and whether it
verified. Reach for it whenever you are about to write a value from memory; `--stdin` answers
one class string per line in a single run. The answer is Tailwind's alone: a rule the project
wrote itself against the same class name is not in it, so grep for `.the-class` first.

When the shell cannot find `tw2stylex`, run `npx tw2stylex <command>` from the project root.

Migrate **leaves first** — a component only after the components it renders. A StyleX child
inside a Tailwind parent is where cascade surprises live.

Watch the total, not only the skips. `tw2stylex plan` over the whole source tree gives one usage
count; if it rises between sessions, Tailwind is still being written faster than you remove it.

## Finishing

The loop above runs per directory. The migration ends when that whole-tree count reaches zero.
Then take the scaffolding back out:

- [ ] Delete every `customClassName` bridge. Each surviving one is a Tailwind class still in
      the build — [component-api.md](references/component-api.md).
- [ ] Drop `className` and `style` DOM props from components that exposed them only so Tailwind
      callers could reach in. A `style` prop typed with `StyleXStylesWithout` stays.
- [ ] Keep Tailwind's base output — preflight and the theme variables — as a plain CSS file
      before deleting Tailwind. Without it the layout falls back to browser defaults —
      "Leaving Tailwind" in [setup.md](references/setup.md).
- [ ] Decide `useCSSLayers` by the rule in [setup.md](references/setup.md): that kept file is
      unlayered CSS.
- [ ] `grep -rn "var(--" src`: each variable it finds is a project token. Done when every one
      is defined outside Tailwind's `@theme` — [tokens.md](references/tokens.md).
- [ ] Remove `tailwindcss`, its entry CSS, and `tw2stylex` from the project.
- [ ] Measure the production CSS, gzipped, against the last Tailwind commit. Done when it is
      no larger, or when each cause in [css-size.md](references/css-size.md) is fixed or ruled out.

## Reading a skip

```
src/ui/Card.tsx:41:18: skipped descendant-selector "[&_svg]:size-4": … fix: Style the child component directly instead.
```

**reason** says why it was skipped; **fix** says what you do about it:

| fix | your move |
|---|---|
| `safe` | One right answer. Batch these. |
| `needs-lookup` | Go find what the tool could not — an ancestor, a child component. |
| `check-first` | A rewrite exists but shifts behaviour at the edges. Read the surrounding code first. |
| `unknown` | Investigate. Often not a Tailwind class at all. |

Filter with `tw2stylex skipped <report.json> --reason <r> --fix <a>`.

## Silent failure is the house style

StyleX rejects most of what it dislikes by rendering nothing: the style is simply gone. Every
rule below is **silent** when broken — the build passes, `plan` sees only what it converted, and
the screenshot diff in step 10 is what catches it.

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
Tailwind. `tw2stylex` catches this as `shorthand-beaten-by-longhand` rather than converting it, but
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
  eliminated, so every unused style in a shared styles module ships as CSS forever. A
  namespace per element in the file that renders it costs no CSS — [css-size.md](references/css-size.md).
- **Reach for a token before a literal, and the codemod's literal before your own.** A repeated
  value the project already spells `spacing.medium` should say so; a hand-written value takes
  the form the codemod emits — "Match the literal" in [tokens.md](references/tokens.md).

## References

- [reason-codes.md](references/reason-codes.md) — one recipe per reason code.
- [component-api.md](references/component-api.md) — the `style` prop contract, banning owned
  properties at the type level, converting `cva`, the `className` bridge. Read it for
  `passed-in-classes`, `variant-function`, or any component that accepts styling from callers.
- [tokens.md](references/tokens.md) — `@theme` → StyleX tokens, the `--` variable bridge, dark
  mode. Read it before touching tokens or theming.
- [setup.md](references/setup.md) — installing StyleX, wiring the build, the CSS entrypoint,
  `useCSSLayers`, the production config, proving it renders. Read it before the first
  conversion in a project, or when a converted component renders unstyled.
- [css-size.md](references/css-size.md) — how to measure, and the ranked causes of a bigger
  bundle with their fixes. Read it when the CSS grew, and for the measurement step in Finishing.

The three pages from step 1 are the authority. Fetch them again for any API this skill does not
cover, and to check a rule here that looks wrong.
