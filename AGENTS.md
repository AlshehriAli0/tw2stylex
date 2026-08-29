# AGENTS.md

TypeScript CLI codemod. No React, no JSX. Bun for running and testing, `tsc` for the build.

## Layout

A bun workspace. The published package is `packages/tw2stylex` (`tw2stylex` on npm, `tw2sx` on the
command line) and holds `src`, `test` and `skills`.
The root is private and holds the README, `assets/`, the shared lint and format config, and
`scripts/`. Run every command from the root; `bun run check` covers the whole workspace.

`scripts/pack.ts` builds the tarball, carrying the root README and LICENSE into the package and
removing them afterwards. It is a script rather than a prepack hook because npm skips lifecycle
scripts under `ignore-scripts`, and that failure is silent.

## Commands

| Command                | What it does                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`        | Everything below, in order. Run this before calling work done.                                                             |
| `bun run format`       | `oxfmt --write .` — rewrites files.                                                                                        |
| `bun run format:check` | Fails if anything is unformatted.                                                                                          |
| `bun run lint`         | `oxlint` — type-aware rules included (`options.typeAware` in `.oxlintrc.json`), so this needs `oxlint-tsgolint` installed. |
| `bun run lint:fix`     | Applies only the fixes oxlint considers safe. Re-run `lint` after; most findings are not auto-fixable.                     |
| `bun run types:check`  | `tsc -p tsconfig.check.json` over `packages/*/src` and `scripts`.                                                          |
| `bun test packages/`   | Bun test runner.                                                                                                           |

Type-aware linting is switched on in `.oxlintrc.json` itself, not by a flag, so the CLI and the
editor see the same errors. Do not turn `options.typeAware` off to make a run faster — it is what
enables `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check` and
`no-unsafe-type-assertion`.

## Editor

`.vscode/` recommends the `oxc.oxc-vscode` extension and makes it the formatter: format on save,
`source.fixAll.oxc` on save, diagnostics as you type. Install it when prompted. ESLint and Prettier
are listed as unwanted — nothing in this repo uses them.

## Rules that will bite

- **Arrow functions only.** `func-style: expression` plus `prefer-arrow-callback`. Write
  `const parse = (input: string) => …`, never `function parse(…)`. Applies to callbacks too.
- **Explicit return types** on standalone functions. Inline expressions and typed function
  expressions are exempt.
- **No `any`, no `!`, no unsafe `as`.** `no-explicit-any`, `no-non-null-assertion`,
  `no-unsafe-type-assertion` are all errors. Narrow with a type guard.
- **`import type`** is required for type-only imports, as a separate statement.
- **`type` over `interface`** — `consistent-type-definitions: type`.
- **Size limits**: complexity 15, depth 4, params 4, 400 lines/file, 120 lines/function.
  Hitting one means split the function, not raise the limit.
- **kebab-case filenames.**

Config lives in `.oxlintrc.json` and `.oxfmtrc.json`. Change a rule only when asked; a rule that
fires is usually right.
