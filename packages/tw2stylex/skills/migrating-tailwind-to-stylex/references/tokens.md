# Tokens: `@theme` → StyleX

Tokens migrate **before** components, because every component references them. Migrating a
component before its tokens exist means rewriting it twice.

Everything below was verified against `@stylexjs/babel-plugin@0.19.0`.

## First: do you need to migrate tokens at all?

Often not. If the project's `@theme` is already a thin alias over hand-written CSS variables:

```css
@theme inline { --color-background: rgb(var(--background)); }
:root { --background: 250 250 250; }
```

then `tw2stylex` emits `backgroundColor: 'rgb(var(--background))'`, which is a perfectly valid
StyleX value referencing a variable StyleX does not own. Runtime theming — tenant themes, a
`.dark` class toggle, anything that rewrites those variables — **keeps working untouched**.

Migrate tokens into StyleX only when you want StyleX to own them: type safety, autocomplete,
dead-code elimination. It is not a prerequisite.

## Tailwind's own variables leave with Tailwind

Tailwind 4 utilities read the default theme through variables: `p-4` is
`calc(var(--spacing) * 4)`, `text-sm` is `var(--text-sm)`. Those variables come from Tailwind's
`theme.css`, so deleting `@import "tailwindcss"` deletes them too.

`tw2stylex` inlines every default Tailwind ships that the project has not overridden: `p-4` becomes
`padding: '1rem'`, `text-red-500` becomes its `oklch(…)` literal. Whatever is still a `var(--…)`
in the output is yours — a token from the project's `@theme`, an override of a Tailwind default,
or a runtime variable behind an `@theme inline` alias. Before removing Tailwind, each of those
must be defined somewhere else: keep the `:root` rule, or move it to `defineVars` with the `--`
bridge below.

## `defineVars` vs `defineConsts`

Ask one question per token group: *does anything override this at runtime?*

- **Yes → `defineVars`.** Emits a real CSS custom property. Almost always colours.
- **No → `defineConsts`.** Inlined at build time, emits no variable, **and can be used as a
  condition key**. Spacing scales, radii, z-index, durations, easings.

Both must live in a `*.stylex.ts` file, be **named exports**, and be the only exports in it.

**Every variable in a `defineVars` group ships, used or not** (facebook/stylex#717, open). A
group holding Tailwind's full palette emits hundreds of declarations for the three colours the
app uses. Define the tokens `grep -rn "var(--"` and the converted code reference, split groups
by concern, and put anything with no runtime override in `defineConsts`, which emits nothing.
`postcss-prune-var` is the maintainers' stopgap when a large group is unavoidable.

**Match the literal.** A StyleX atom is keyed on the value string, so `padding: 16`, `'16px'`
and `'1rem'` are three rules. `tw2stylex` emits Tailwind's own form — `'1rem'`, `oklch(…)`,
`calc(infinity * 1px)`; `tw2stylex explain` prints it. Hand-written values take that form, or
a token, which covers both sides.

## The `--` literal-key bridge

A `--`-prefixed key makes `defineVars` emit that exact CSS variable name instead of a hashed
one. Verified:

```ts
export const colors = stylex.defineVars({
  '--background': 'oklch(98% 0.01 95)',
  foo: 'red',
});
```
```css
:root, .xr4ttzw { --background: oklch(98% 0.01 95); --xmdamkz: red; }
```

`--background` comes out verbatim; `foo` becomes `--xmdamkz`. That is the bridge between StyleX
and everything that is not StyleX — escape-hatch CSS, third-party widgets, a runtime theme
injector — because both sides can now name the same variable.

If you adopt it for names the project already defines in `:root`, **delete the old definitions
in the same commit**. Two live definitions of one variable makes theming ambiguous.

While Tailwind still coexists, keep `@theme inline { --color-background: var(--background); }`
so Tailwind utilities and StyleX resolve to identical values. That is what keeps mid-migration
screenshots clean.

## ⚠️ Cross-file `defineConsts` is broken in 0.19.0

Two widely-shared StyleX skills tell you to put breakpoints in a shared `consts.stylex.ts`.
**Keep breakpoints file-local until this is fixed.** Reproduced against 0.19.0:

```ts
// consts.stylex.js
export const bp = stylex.defineConsts({ md: '@media (min-width: 768px)' });

// comp.js
import { bp } from './consts.stylex.js';
stylex.create({ a: { padding: { default: 4, [bp.md]: 16 } } });
```

emits

```css
var(--x130wd72){.x1a8kthd.x1a8kthd{padding:16px}}
```

— an invalid at-rule, no error, the media query destroyed. See facebook/stylex#1825.

`defineConsts` also *must* be bound to a named export (`The return value of defineConsts() must
be bound to a named export`), so there is no same-file workaround.

Write breakpoint strings literally in each file for now. That is the copy-paste this migration
is meant to end, and it still beats silently broken CSS. Re-test on each StyleX upgrade and
switch the moment it works.

```ts
const MD = '@media (min-width: 768px)';   // file-local, until #1825 lands
const styles = stylex.create({ a: { padding: { default: 4, [MD]: 16 } } });
```

Note the underlying constraint that motivates the shared-const advice is real: **a media query
is a *key*, and only a const can be a key.** A `defineVars` breakpoint cannot work at all.

## Dark mode

Three options, in order of preference:

1. **`light-dark()`** — verified working as a plain value:
   `color: 'light-dark(black, white)'`. Encode both palettes in one token and let
   `color-scheme` decide. Simplest, no theme plumbing, works with a three-way
   system/light/dark toggle, and one declaration where a `dark:` pair was two.
2. **`stylex.createTheme()`** — when you need more than two palettes, or per-subtree overrides.
   Apply the theme on the element that currently carries `.dark`. Each theme re-declares the
   whole variable group at doubled specificity, so keep themed groups small.
3. **`@media (prefers-color-scheme: dark)` inside `defineVars`** — only when the project has no
   class toggle. Note `defineVars` values accept `default` plus **at-rule keys only**; a class
   or attribute selector there does not work, which is why class-based dark mode needs (1) or (2).
