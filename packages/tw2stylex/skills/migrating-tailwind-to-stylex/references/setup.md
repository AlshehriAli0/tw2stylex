# Setup

Step 0 of the loop, once per project. An unwired build renders every converted component
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
npm install --save-dev @stylexjs/babel-plugin @stylexjs/postcss-plugin   # Next.js instead
```

Use the project's own package manager — `bun add`, `pnpm add`, `yarn add`.

**Vite** — the StyleX plugin goes before the React plugin, or Fast Refresh breaks:

```ts
// vite.config.ts
import stylex from '@stylexjs/unplugin';

export default defineConfig({
  plugins: [stylex.vite({ useCSSLayers: false }), react()],
});
```

`stylex.webpack()`, `stylex.rspack()`, `stylex.esbuild()` and `stylex.rollup()` take the same
options. **Next.js** needs `babel.config.js` plus `postcss.config.js` — copy them from the
installation doc linked above rather than from memory.

**Vitest** reads `vite.config.ts` only when no higher-priority Vitest config replaces it. A
separate `vitest.config.ts` overrides the Vite config, and isolated `test.projects` do not inherit
parent plugins unless they opt in. Every project that imports StyleX source must include or
inherit the transform. For an isolated DOM project, the direct setup is:

```ts
// vitest.config.ts
import stylex from '@stylexjs/unplugin';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [stylex.vite({ useCSSLayers: false })],
        test: { name: 'dom', environment: 'jsdom' },
      },
    ],
  },
});
```

`Unexpected 'stylex.create' call at runtime` means that test project did not run the transform.
An application build passing proves only that the application config is wired.

**Every setup needs a CSS entrypoint.** One CSS file, imported from the app root, containing:

```css
@stylex;
```

The plugin appends every generated rule to that file. Without it nothing is emitted at all.

## Two settings the migration needs

**`useCSSLayers: false` while Tailwind is still in the build.** Unlayered CSS beats layered
CSS. With layers on, StyleX loses to the
Tailwind you have not deleted yet and migrated components keep their old styles. Flip it to
`true` after the last Tailwind class is gone.

**`include` covering the files you are migrating**, for the Next.js/PostCSS path. A file outside
the pattern compiles to nothing.

## Prove it works before converting anything

Style one `<div>` by hand, load the page, read its computed styles:

```tsx
import * as stylex from '@stylexjs/stylex';
const check = stylex.create({ it: { backgroundColor: 'red' } });
<div {...stylex.props(check.it)}>wired</div>
```

Red means the plugin, the entrypoint and the import are all correct. Not red means the build
is not wired, and every conversion after this point will look broken for that reason alone.

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

## Performance

StyleX compiles to static CSS, so styles created and applied in one file cost nothing at
runtime. Two things keep the build itself fast: narrow `include`/`exclude` patterns, and
`treeshakeCompensation: true` if your bundler is dropping styles it should keep.
