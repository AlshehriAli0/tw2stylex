# CSS size

Read when a CSS bundle grew, and for the measurement step in "Finishing".

## How the size works

StyleX emits one rule per distinct `(property, value, condition)`, deduped across the app. The
atom is keyed on the value string and the condition — the namespace, file and style name are
outside the hash, so a namespace per element costs no CSS, and the same declaration written in
fifty files costs one rule.

`tw2stylex` writes the resolved literal — `padding: '1rem'` where Tailwind 4 emits
`padding: calc(var(--spacing) * 4)`, one `boxShadow` string where Tailwind composes five
`--tw-*` slots and registers each with `@property` — so the converted sheet is about half the
size of the utilities it replaces (128 utilities, minified, `useCSSLayers: true`: 10,561 → 5,306
bytes raw, 2,682 → 2,178 gzipped).

## Measure

- **Tailwind's sheet shrinks only when a class string is gone from every file it scans.**
  Converted files lose theirs; these keep them alive: unconverted files, `cva` definitions in
  another file, tests and stories, MDX, `.tw2stylex/` reports (`plan` gitignores them), and this
  skill's own examples until `.claude`/`.agents` is excluded with `@source not`. Grep the
  Tailwind output for the classes you converted; each hit names a file still to find. Done when
  every converted class is absent.
- The production build. `dev`, `debug`, `runtimeInjection` all `false` — [setup.md](setup.md)
  "Production config".
- One StyleX CSS file — [setup.md](setup.md) "CSS entrypoint".
- Gzipped, after the bundler's minifier.

## Causes, largest first

**`useCSSLayers: false`.** StyleX polyfills its priority order by appending `:not(#\#)` to every
rule above the lowest priority — 5,306 → 7,707 bytes on the corpus above. `tw2stylex init` turns
layers on for Tailwind 4; the rule for other setups is in [setup.md](setup.md).

**Every variable in a `defineVars` group ships, used or not** — "`defineVars` vs
`defineConsts`" in [tokens.md](tokens.md).

**Exported style modules.** Unused entries in an exported `stylex.create` cannot be detected
(facebook/stylex#729), so each ships forever. Styles live in the file that renders them.

**Unit drift in hand-written styles.** One value in three spellings is three atoms — "Match the
literal" in [tokens.md](tokens.md).

**A theme per palette, or a `dark:` pair kept as two atoms** — "Dark mode" in
[tokens.md](tokens.md).

**`styleResolution` changed from the default** — "Production config" in [setup.md](setup.md).

**Responsive ladders that differ by property.** `enableMediaQueryOrder` rewrites `md:` to
`(min-width: 48rem) and (max-width: 63.99rem)` only when the same property also carries `lg:`,
so `md:p-4` alone and `md:p-4 lg:p-8` are two atoms where Tailwind has one. Leave the option
on; it is what makes a breakpoint ladder resolve in order.

**Pseudo-elements and positional pseudo-classes.** StyleX's authoring guide names
`::before`/`::after` and `:first-child`/`:nth-child` as CSS-size costs and prefers a real
element or a JS condition. Tailwind's `before:`, `after:`, `first:`, `last:` convert correctly;
take the guide's route when the component is open for other reasons.

## Confirm these left with Tailwind

Its `@property` registrations and `--tw-*` slot variables, the `@layer properties` fallback
block, plugin CSS (`tw-animate-css`, typography), `@apply` component classes, and every utility
a dynamic class string kept alive. Preflight stays — "Leaving Tailwind" in [setup.md](setup.md).
