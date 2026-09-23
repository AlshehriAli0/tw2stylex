# Retire Tailwind after the last zone

Reach this only when the user is migrating the whole project and the remaining Tailwind usage
count is zero. A scoped CSS rule is still valid when StyleX cannot express it.

1. Run `tw2stylex plan <source-root>` and inspect the whole-tree count. Search for Tailwind
   classes in unscanned sources, generated component imports, `cva`, templates, and runtime class
   builders. Check each unexplained skip; a zero count in the report covers only scanned files.
2. Remove temporary `className` bridges and component styling props that exist solely for
   Tailwind callers. Keep public styling APIs that callers actually use.
3. Preserve Tailwind's reset and any still-needed theme variables as plain CSS before removing
   its import. Follow [setup.md](setup.md#leaving-tailwind). Confirm every `var(--...)` in the
   remaining StyleX and CSS has a definition outside Tailwind output. Keep custom global CSS,
   plugin CSS, and scoped CSS that still own real behavior.
4. Remove Tailwind packages, configuration, and `tw2stylex` only after no remaining consumer
   needs them. Re-check `useCSSLayers`, since retained unlayered CSS can change precedence.
5. Run the production build, typecheck, and relevant UI checks. Compare production CSS size with
   the baseline; use [css-size.md](css-size.md) if it grew. Report residual CSS fallbacks and
   any states that could not be verified.
