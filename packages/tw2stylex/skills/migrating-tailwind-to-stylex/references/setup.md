# Setup

Step 2 of the loop, once per project. An unwired build renders every converted component
unstyled, which looks exactly like a bad conversion and is not one.

## Is it already installed?

```bash
cat package.json | grep -i stylex
```

`@stylexjs/stylex` in `dependencies` and a plugin in `devDependencies` means installed — skip to
[Two settings the migration needs](#two-settings-the-migration-needs). Anything less, install it.

## Install

```bash
npm install @stylexjs/stylex                      # runtime, always
npm install --save-dev @stylexjs/unplugin         # Vite, Rollup, Webpack, esbuild, Rspack
npm install --save-dev @stylexswc/nextjs-plugin    # Next.js 15+
npm install --save-dev @stylexjs/babel-plugin @stylexjs/postcss-plugin   # Next.js 14
```

Use the project's own package manager — `bun add`, `pnpm add`, `yarn add`.

**Vite** — the StyleX plugin goes before the React plugin, or Fast Refresh breaks:

```ts
// vite.config.ts
import stylex from '@stylexjs/unplugin/vite';

export default defineConfig({
  plugins: [stylex({ useCSSLayers: true }), react()],   // see "Two settings" below
});
```

Each bundler has its own adapter — `@stylexjs/unplugin/vite`, `/webpack`, `/rspack`,
`/esbuild`, `/rollup` — with the same options; the package root loads all of them at once.

**Next.js 15+** — `@stylexswc/nextjs-plugin` keeps SWC. Copy its `next.config` from the
package README rather than from memory.

**Next.js 14** — `babel.config.js` plus `postcss.config.js`, copied from the installation page
read in step 1. This switches the whole build off SWC, which costs: `next/font` fails with
`"next/font" requires SWC` (self-host the fonts), client JavaScript grows about 10% gzipped
before a single style is migrated, and `@babel/runtime` must stay on v7. Say so in your summary
before taking this path.

**Vitest** — a separate `vitest.config.ts` replaces `vite.config.ts`, and each entry in
`test.projects` starts with an empty plugin list. Every config that imports StyleX source needs
the plugin too:

```ts
// vitest.config.ts
import stylex from '@stylexjs/unplugin/vite';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [stylex({ useCSSLayers: true })],
        test: { name: 'dom', environment: 'jsdom' },
      },
    ],
  },
});
```

`Unexpected 'stylex.create' call at runtime` in a test means that project ran without the
plugin, even when the app build passes.

**Every setup needs a CSS entrypoint.** One CSS file, imported from the app root, containing:

```css
@import "tailwindcss";   /* while Tailwind is still in the build */
@stylex;
```

The plugin replaces `@stylex;` with every generated rule. Without it nothing is emitted at all;
with two of them (or the CLI and the unplugin on the same files) every rule ships twice.

## Two settings the migration needs

**`useCSSLayers` decides who wins, and costs a third of the CSS.** Unlayered CSS beats layered
CSS. Off, StyleX is unlayered and beats everything, polyfilling its own priority order with
`:not(#\#)` on nearly every rule — a third of the raw stylesheet. On, StyleX sits in
`@layer priority1…N` and loses to any unlayered rule on the page.

- **Tailwind 4** is layered (`@layer theme, base, components, utilities`), so `true` works from
  day one when `@stylex;` follows `@import "tailwindcss";` — later-declared layers win. The
  same holds for the base file kept after Tailwind leaves.
- **Tailwind 3**, a reset, `@font-face`, a global stylesheet are unlayered. `false` until each
  is wrapped — `@import "./reset.css" layer(base);` — then `true`.

Rules that set CSS custom properties are emitted outside any layer (facebook/stylex#1611), so a
layered global cannot override a StyleX variable. `tw2stylex plan` verifies declarations, not
cascade order; the screenshot diff in SKILL.md step 10 is what proves the choice.

**`include` covering the files you are migrating**, for the Next.js/PostCSS path. A file outside
the pattern compiles to nothing.

## Leaving Tailwind

Tailwind's base output stays when Tailwind goes. It holds preflight — `box-sizing`, heading
sizes, margins, the default border colour — and the theme variables, resolved against the
project's config. Compile it once with Tailwind's own CLI and import the output where the entry
CSS was:

- Entry written as `@tailwind base;` — a file holding only that line:
  `npx tailwindcss -i base.css -o src/tailwind-base.css`.
- Entry written as `@import "tailwindcss";` — a copy of the entry with that line changed to
  `@import "tailwindcss" source(none);`: `npx @tailwindcss/cli -i copy.css -o src/tailwind-base.css`.

Done when the app renders the same with the Tailwind import gone.

## Prove development works before converting anything

Style one `<div>` by hand, load the page, read its computed styles:

```tsx
import * as stylex from '@stylexjs/stylex';
const check = stylex.create({ it: { backgroundColor: 'red' } });
<div {...stylex.props(check.it)}>wired</div>
```

Red means the plugin, the entrypoint and the import are all correct. Not red means the build
is not wired, and every conversion after this point will look broken for that reason alone.

## Prove production works too

Before deleting the red check, run the project's real production build (and its SSR build, if
it has one) and look at the output:

- One emitted CSS file contains the red StyleX rule.
- No production JavaScript contains `stylex.create` or a `virtual:stylex` import.
- If the app has SSR, one production render completes without a StyleX runtime error.

A passing typecheck only proves `@stylexjs/stylex` is installed. The CSS file proves the compiler
ran; the JavaScript and SSR checks prove it ran in every build.

## When styles do not appear

In this order:

1. The CSS file holding `@stylex;` is imported from the app root.
2. The file is inside the plugin's `include` pattern.
3. The StyleX plugin runs before the other transforms.
4. `useCSSLayers` matches the rule above.

## Worth turning on

```bash
npm install --save-dev @stylexjs/eslint-plugin
```

`valid-styles` and `no-unused` as errors, `valid-shorthands` and `sort-keys` as warnings. This
catches at lint time much of what StyleX otherwise drops silently, which is the whole hazard
class this skill exists to handle.

## Production config

The defaults are right. Each option here is listed because a project that changed it ships a
bigger build with no warning:

| option | production value | otherwise |
|---|---|---|
| `dev` | `false` | styles injected at runtime, no static CSS file |
| `debug` | `false` | `data-style-src` on every element; with `enableDebugClassNames`, longer selectors |
| `runtimeInjection` | `false` | the style-injection runtime ships in the JS bundle |
| `styleResolution` | `'property-specificity'` | `legacy-expand-shorthands` expands every shorthand, +20% CSS; `application-order` bloats compiled JS |

`treeshakeCompensation: true` is the fix when the bundler drops a `.stylex.ts` import a style
depends on. Narrow `include`/`exclude` keeps the build fast.
