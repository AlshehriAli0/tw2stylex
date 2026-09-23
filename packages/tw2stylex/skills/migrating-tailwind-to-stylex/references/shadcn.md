# Migrate local shadcn components

Reach this when the selected zone imports local shadcn-style components. Inspect `components.json`,
the local component and its callers first. [shadcn-cssinjs](https://www.shadcn-cssinjs.com/docs)
is a StyleX/Base UI component registry that can coexist with shadcn/ui; its
[installation guide](https://www.shadcn-cssinjs.com/docs/installation) explains its build and
token setup. Treat each registry component as a candidate implementation, not a replacement
contract. Use the project's existing StyleX setup rather than installing a second pipeline.

For each component used by the zone:

1. Compare the local component with its [registry peer](https://www.shadcn-cssinjs.com/docs)
   and list the differences that callers can observe: exports, prop types and defaults,
   variants and sizes, `className`/style overrides, underlying primitive, refs, slots, data
   attributes, portals, keyboard behavior, RTL, open/close timing, keyframes, and responsive or
   themed values. Check local CSS and animations as well as the TSX file. A registry peer may be
   absent or may use a different primitive; convert the local component in that case.
2. Build a **1:1 StyleX peer** preserving those contracts and project customizations. Borrow
   registry code only where it matches. Adapt its tokens to the project's variable format:
   the registry's [token file](https://www.shadcn-cssinjs.com/r/stylex-tokens.json) uses values
   like `var(--primary)`, while a project storing RGB triplets needs `rgb(var(--primary))`.
   If local CSS styles arbitrary children (such as a Button's SVGs), keep that rule in scoped
   CSS when callers cannot pass a StyleX style to every child. Check the rule's exact selector
   and class-name assumptions after migration.
3. Migrate styling overrides in callers within the selected scope. A Tailwind `className` that
   changes a Button's appearance can become a caller-owned StyleX style passed through the
   component's styling API; preserve its hover, focus, disabled, and theme states as a whole.
   For other callers, keep a temporary `className` bridge only when the resulting cascade has
   been checked. [component-api.md](component-api.md) covers precedence and type contracts.
4. Check the component in its actual route, including the custom states from step 1. A passing
   `plan` proves only the classes it converted, not Base UI/Radix behavior or animation parity.

For a shared component, follow the [coexistence rule](component-api.md#coexistence-with-tailwind-callers):
keep its existing export and use a separate StyleX peer for the selected zone while other callers
still need the Tailwind API. Switch imports by zone.
