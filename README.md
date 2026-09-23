# tw2stylex

Agent-driven, incremental Tailwind to StyleX migration. Converts what it can prove, and turns
the rest into work an agent can pick up.

<p>
  <a href="https://www.npmjs.com/package/tw2stylex"><img src="https://img.shields.io/npm/v/tw2stylex" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/tw2stylex"><img src="https://img.shields.io/npm/dm/tw2stylex" alt="npm downloads" /></a>
  <a href="https://github.com/AlshehriAli0/tw2stylex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tw2stylex" alt="license" /></a>
</p>

<img src="assets/demo.svg" alt="tw2stylex plan output" width="750">

No codemod finishes this job. tw2stylex converts only what it can verify against the real StyleX
compiler, which is what `MISMATCHES: 0` means, and reports the rest as typed skips.
`tw2stylex init` sets the repo up so your agent can work through them.

## Give this to your agent

Use `/goal` or the equivalent command in your agent harness from the project root.

```text
/goal Migrate this codebase from Tailwind to StyleX with tw2stylex. Install it with the project's package manager if needed, run tw2stylex init, then read and follow the installed migrating-tailwind-to-stylex skill in full. Complete its whole-project migration and verification criteria.
```

## Install

```bash
npm i -D tw2stylex     # bun add -d tw2stylex · pnpm add -D tw2stylex
npx tw2stylex init     # sets the repo up for your agent
```

## The loop

```bash
tw2stylex plan src/components           # MISMATCHES must be 0; the skips are the work
tw2stylex apply src/components --write  # rewrites only what converts cleanly
tw2stylex skipped .tw2stylex/plan-*.json --fix safe
                                    # ...resolve those by hand
```

Repeat for each selected route or component. Tailwind can keep styling untouched parts of the
app while StyleX takes over the selected zone. `plan` and `apply` agree on what converts, so the
report never promises something `apply` will skip.

| command | what it does |
|---|---|
| `tw2stylex init` | Set the repo up for your agent. Safe to re-run. |
| `tw2stylex explain "<classes>"` | Resolve a class string to a StyleX object. Touches nothing. |
| `tw2stylex plan <path>` | Scan, convert, verify. Writes a JSON report. **Never edits code.** |
| `tw2stylex apply <path>` | Rewrite the sites that convert cleanly. Dry run unless `--write`. |
| `tw2stylex skipped <report>` | Re-read a report, filtered by `--reason` / `--fix`. |

## Skips

Each one says what stopped it, and how much work it will be:

| fix | means |
|---|---|
| `safe` | one right answer, fine to do in bulk |
| `check-first` | a rewrite exists but can change behaviour; read the code |
| `needs-lookup` | go find something first: a parent element, a child component |
| `unknown` | investigate; often not a Tailwind class at all |

[reason-codes.md] walks through each reason. [tokens.md] covers `@theme`
tokens and dark mode. [css-size.md] lists what makes the stylesheet bigger than it needs to be,
and the fix for each.

## For agents

The skill goes into `.claude/skills` or `.agents/skills`, whichever the project already has.
It first maps the project's tokens, runtime themes, CSS, component contracts, and migration
scope. It guides 1:1 StyleX peers for customized shadcn components, using the
[shadcn-cssinjs registry](https://www.shadcn-cssinjs.com/docs) as a candidate rather than
overwriting local behavior. It also teaches this failure, which StyleX gives you no warning
about:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is GONE. No error.
```

`StyleXStylesWithout` can make owned-property overrides a compile error when a component's
contract forbids them. Existing intentional overrides need a typed StyleX path that preserves
their states. [component-api.md] has both cases.

## Notes

`tailwindcss` is a peer dependency. tw2stylex runs your copy, not a bundled one, so your theme and
plugins are in scope. It looks for the CSS that imports Tailwind, or a `tailwind.config` file.
Pass `--css` or `--config` if it picks the wrong one.

Pin both versions. tw2stylex reaches into Tailwind's internals, and comparing skip counts between
runs only works if nothing moved underneath.

Exit codes: `0` clean · `1` finished with skips · `2` usage · `3` precondition · `10` internal.
`tw2stylex help` has the flags.

Run against a production Tailwind app: 970 files, 7,125 usages, 5,509 converted, zero
mismatches, 809ms. Node and Bun produce identical output.

The output is smaller than what it replaces: tw2stylex writes the resolved literal where Tailwind
4 writes `calc(var(--spacing) * 4)` and five `--tw-*` slots. Measured on 128 utilities, minified,
`useCSSLayers: true`: 10,561 → 5,306 bytes raw, 2,682 → 2,178 gzipped. `tw2stylex init` turns
layers on; [css-size.md] has what to check when a bundle grows anyway.

[SKILL.md]: skills/migrating-tailwind-to-stylex/SKILL.md
[reason-codes.md]: skills/migrating-tailwind-to-stylex/references/reason-codes.md
[tokens.md]: skills/migrating-tailwind-to-stylex/references/tokens.md
[css-size.md]: skills/migrating-tailwind-to-stylex/references/css-size.md
[component-api.md]: skills/migrating-tailwind-to-stylex/references/component-api.md
