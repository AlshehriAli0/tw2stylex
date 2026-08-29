# CSS size

Read when a CSS bundle grew, before quoting anyone a number, and for the measurement step in
"Finishing".

## Parity is the target

Tailwind is already atomic CSS. So is StyleX: one rule per distinct
`(property, value, condition)`, deduped across the app, keyed on the value string and nothing
else — the namespace, file and style name are outside the hash, so a namespace per element
costs no CSS. For the same utilities the two stylesheets are the same size. StyleX's "80%
smaller" and "plateaus as the codebase grows" are measured against hand-written per-component
CSS.

Measured, StyleX 0.19 vs Tailwind 4.3, one 66-element corpus, production build: +7% raw with
`useCSSLayers: true`, +53% with it off, about +60% gzipped either way because hashed class
names do not compress. A published 20-component migration: 20,379 → 20,561 bytes. Anything
beyond that has a cause below.

## Measure

- The production build, after Tailwind is gone. Mid-migration two atomic stylesheets are on
  the page, so the total rises before it falls.
- One StyleX CSS file — [setup.md](setup.md) "CSS entrypoint". Tailwind 4 scans every
  non-gitignored file, so the class strings in this skill's examples reach the Tailwind bundle
  until `.claude`/`.agents` is excluded with `@source not`.
- `dev`, `debug`, `runtimeInjection` all `false` — [setup.md](setup.md) "Production config".
- Gzipped, after the bundler's minifier. StyleX's per-atom `@media` wrappers compress away.

## Causes, largest first

**`useCSSLayers: false`.** StyleX polyfills its priority order by appending `:not(#\#)` to every
rule above the lowest priority — a third of the raw bytes. The rule for turning layers on is in
[setup.md](setup.md).

**Every variable in a `defineVars` group ships** (facebook/stylex#717, open). Define the tokens
the code uses; constants go in `defineConsts` — [tokens.md](tokens.md).

**Exported style modules.** Unused entries in an exported `stylex.create` cannot be detected
(facebook/stylex#729), so each ships forever. Styles live in the file that renders them.

**Unit drift in hand-written styles.** `'1rem'`, `16` and `'16px'` are three atoms. Write the
codemod's literal — [tokens.md](tokens.md) "Match the literal".

**A theme per palette.** `stylex.createTheme` re-declares the whole variable group per theme;
`light-dark()` in one token is one declaration. A `dark:` pair converted as a
`@media (prefers-color-scheme: dark)` condition stays two atoms — "Dark mode" in
[tokens.md](tokens.md).

**`styleResolution` other than the default.** `legacy-expand-shorthands` expands `padding`
into four longhands: +30% rules, +20% bytes. Keep `property-specificity`, which `tw2stylex`
verifies against.

**Responsive ladders that differ by property.** `enableMediaQueryOrder` rewrites `md:` to
`(min-width: 48rem) and (max-width: 63.99rem)` only when the same property also carries `lg:`,
so `md:p-4` alone and `md:p-4 lg:p-8` are two atoms where Tailwind has one. Leave the option
on; it is what makes a breakpoint ladder resolve in order.

**Pseudo-elements and positional pseudo-classes.** StyleX's authoring guide names
`::before`/`::after` and `:first-child`/`:nth-child` as CSS-size costs and prefers a real
element or a JS condition. Tailwind's `before:`, `after:`, `first:`, `last:` convert correctly;
take the guide's route when the component is open for other reasons.

## Where StyleX does shrink

Tailwind's `@property` registrations and `--tw-*` slot variables leave with it; `light-dark()`
tokens replace `dark:` pairs; and with every style beside its markup, no unused CSS ships.
Those are the levers.
