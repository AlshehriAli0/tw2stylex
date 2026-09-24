---
name: migrating-tailwind-to-stylex
description: >-
  Migrate Tailwind to StyleX with tw2stylex, including partial migrations, shadcn components,
  runtime themes, and skipped usages. Use when setting up StyleX, running tw2stylex, or resolving
  its report.
---

# Migrate Tailwind to StyleX

`tw2stylex` converts a class usage only when its generated StyleX has the same CSS declarations
as the project's Tailwind compiler. It reports everything else as a skip. Declaration equality
does not prove cascade, component behavior, or visual parity; resolve and check those in the app.

## Work one migration zone at a time

1. **Understand the system.** Read [project-map.md](references/project-map.md) before the first
   migration in a project and revisit the affected parts for each zone. Trace the project's token
   sources, runtime theme writers, CSS layers and globals, component APIs and consumers, dynamic
   styles, motion, and test paths. Choose the zone from the user's scope. Done when you can say
   where every style source that can affect this zone comes from and which consumers a shared
   change would affect.
2. **Prepare coexistence.** Install and prove StyleX in the actual build using
   [setup.md](references/setup.md). Keep Tailwind and existing CSS working for unmigrated code.
   Use [tokens.md](references/tokens.md) to decide how StyleX reads the *existing* design tokens;
   moving token ownership is a separate choice. Capture the zone's current appearance and
   interaction states before editing.
3. **Plan, then apply.** Run `tw2stylex plan <path>` on the zone. Use its grouped component
   callers and import paths to choose what to inspect. If `MISMATCHES` exceeds 0, keep that
   output unapplied. Reproduce the class with `explain`, check the project's Tailwind entry and
   plugins, and report a tool bug if it still differs. Otherwise review
   `tw2stylex apply <path> --diff`, then run `tw2stylex apply <path> --write`. `apply` may leave
   other usages in the file. Use `--allow-dirty` only after inspecting existing edits.
4. **Finish the skips.** Re-run `plan`; `skipped <report>` warns if its inputs or tool version
   changed. Work each skip through
   [reason-codes.md](references/reason-codes.md). Read [component-api.md](references/component-api.md)
   for components that accept caller styles or use `cva`; read
   [shadcn.md](references/shadcn.md) when the zone uses local shadcn components. Use
   [tokens.md](references/tokens.md) for optional exact `defineConsts` mappings. A
   `files[].sourceStatus` of `fragment` means the candidate source is incomplete; read
   `unresolvedClasses` and review `reviewNames` before using generated keys. Use
   [stylex-limits.md](references/stylex-limits.md) when writing StyleX by hand. Preserve the
   behavior of CSS-only rules in a scoped CSS file when StyleX cannot express them. Re-run
   `plan` after each batch; account for every remaining skip in the selected zone.
5. **Check the result.** Run the project's relevant typecheck and build, then compare the changed
   UI and interactions against the baseline in the states that matter here: themes, tenant or
   draft previews, responsive layouts, RTL, focus, open and closed states, and motion as
   applicable. The agent chooses the available checks for the project and reports what was not
   verified. Done when the zone's styles and component contracts are preserved, every target
   usage is converted or has an explained CSS fallback, and `MISMATCHES` is 0. Report the zone,
   converted usages, retained CSS, relevant checks, and any unverified states.

Repeat for the next zone. A partial migration is complete when its *selected zone* meets step 5;
the whole project need not be free of Tailwind yet. Use [finishing.md](references/finishing.md)
only when retiring Tailwind across the project. If production CSS grows, follow
[css-size.md](references/css-size.md).

`tw2stylex explain "<classes>"` gives the exact StyleX object and verification result for a
class string. Check the project's own CSS rules for the same class before treating that output as
the complete cascade. If `tw2stylex` is not on `PATH`, run it through the project's package
manager. Run `tw2stylex init` to install or update this skill; if its installed version differs
from `tw2stylex --version`, refresh the skill before using its reason codes.
