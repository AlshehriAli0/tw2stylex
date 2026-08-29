# tw2sx

Migrate Tailwind to StyleX. Converts what it can prove, reports what it can't.

```
$ tw2sx plan app
21 files · 69 usages · 23 converted · 46 skipped
MISMATCHES: 0

app/contact/page.tsx:53:12: skipped parent-state "dark:text-slate-300": … fix: For dark mode
use stylex.createTheme(); otherwise stylex.when.ancestor() with a marker.

Showing 1 of 74 skipped.

Skipped, in the order to work them:
  safe
    marker-class              7
  needs-lookup
    parent-state             39
    descendant-selector       7
    sibling-state             7
  check-first
    dynamic-classes           8
    styles-children           4
    passed-in-classes         2

Full report: .tw2sx/plan-3d35e4.json
Next: tw2sx skipped .tw2sx/plan-3d35e4.json --fix safe --limit 20
```

Every conversion gets compiled through the real StyleX Babel plugin, and its declarations
checked against the ones Tailwind produced. That is what `MISMATCHES: 0` means.

Tailwind and StyleX do not map onto each other cleanly, so a lot will not convert. Those get
skipped and listed, each with a reason and a way to fix it by hand.

## Install

```bash
npm i -D tw2sx     # bun add -d tw2sx · pnpm add -D tw2sx
npx tw2sx init     # installs the agent skill
```

## The loop

```bash
tw2sx plan src/components           # MISMATCHES must be 0; the skips are the work
tw2sx skipped .tw2sx/plan-*.json --fix safe
                                    # ...resolve those by hand
tw2sx apply src/components --write  # rewrites only what converts cleanly
```

Repeat until the skip count stops dropping. `plan` and `apply` agree on what converts, so the
report never promises something `apply` will skip.

| | |
|---|---|
| `tw2sx init` | Install the agent skill. Safe to re-run. |
| `tw2sx explain "<classes>"` | Resolve a class string to a StyleX object. Touches nothing. |
| `tw2sx plan <path>` | Scan, convert, verify. Writes a JSON report. **Never edits code.** |
| `tw2sx apply <path>` | Rewrite the sites that convert cleanly. Dry run unless `--write`. |
| `tw2sx skipped <report>` | Re-read a report, filtered by `--reason` / `--fix`. |

## Skips

Each one says what stopped it, and how much work it will be:

| fix | means |
|---|---|
| `safe` | one right answer, fine to do in bulk |
| `check-first` | a rewrite exists but can change behaviour; read the code |
| `needs-lookup` | go find something first: a parent element, a child component |
| `unknown` | investigate; often not a Tailwind class at all |

There are 17 reasons. [reason-codes.md] walks through each one. [tokens.md] covers `@theme`
tokens and dark mode.

## For agents

`tw2sx init` copies [SKILL.md] into `.claude/skills` or `.agents/skills`, whichever the project
already has. The main thing it teaches is this failure, which StyleX gives you no warning about:

```js
base:    { backgroundColor: { default: 'X', ':hover': 'Y' } }
variant: { backgroundColor: 'Z' }
stylex.props(styles.base, styles.variant)   // -> Z. The :hover rule is GONE. No error.
```

`StyleXStylesWithout` turns that into a compile error, by letting a component ban the properties
it owns from its own style prop. [component-api.md] has the pattern.

## Notes

`tailwindcss` is a peer dependency. tw2sx runs your copy, not a bundled one, so your theme and
plugins are in scope. It looks for the CSS that imports Tailwind, or a `tailwind.config` file.
Pass `--css` or `--config` if it picks the wrong one.

Pin both versions. tw2sx reaches into Tailwind's internals, and comparing skip counts between
runs only works if nothing moved underneath.

Exit codes: `0` clean · `1` finished with skips · `2` usage · `3` precondition · `10` internal.
`tw2sx help` has the flags.

Run against a production Tailwind app: 970 files, 7,125 usages, 5,509 converted, zero
mismatches, 0.7s. Node and Bun produce identical output.

[SKILL.md]: skills/migrating-tailwind-to-stylex/SKILL.md
[reason-codes.md]: skills/migrating-tailwind-to-stylex/references/reason-codes.md
[tokens.md]: skills/migrating-tailwind-to-stylex/references/tokens.md
[component-api.md]: skills/migrating-tailwind-to-stylex/references/component-api.md
