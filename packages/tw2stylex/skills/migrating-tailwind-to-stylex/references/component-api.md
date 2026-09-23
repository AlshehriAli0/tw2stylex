# Component styling API

Reach this when a component accepts caller styles, a `className` moves through a component,
or a `cva()` definition is being replaced. Inspect the current component **and its callers**
before choosing the StyleX API. A 1:1 peer keeps its variants, defaults, slots, refs, and
intentional caller overrides.

## Preserve the override contract

`stylex.props()` merges left to right **per property**. A caller's flat `backgroundColor`
override removes the component's hover background too. If callers may override that property,
the caller style must carry its relevant states, or the component must expose an explicit
variant/slot that does. Migrate a Tailwind override at the call site to a StyleX style and check
its actual rendered states.

Use `style?: StyleXStylesWithout<{ ... }>` when the component's contract **forbids** overriding
owned properties. The map needs concrete CSS types, and DOM props need `Omit<..., 'style'>` to
avoid colliding with React's `CSSProperties`. When the current component intentionally accepts
owned-property overrides, keep that ability with a typed StyleX style prop and merge it last;
do not narrow the API silently during a 1:1 migration.

```tsx
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  base: { display: 'inline-flex' },
  primary: { backgroundColor: { default: 'blue', ':hover': 'darkblue' } },
});

type ButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  variant?: 'primary';
  style?: StyleXStyles;
};

const Button = ({ variant = 'primary', style, ...props }: ButtonProps) =>
  <button {...props} {...stylex.props(styles.base, styles[variant], style)} />;
```

The component must pass the style to its actual host element. A `stylex.props()` spread on
`<Button>` does not reach the `<button>` it renders. Keep JSX spreads ordered so neither caller
props nor a later `className` overwrites the merged StyleX result.

## Coexistence with Tailwind callers

A shared component may still receive Tailwind `className` overrides. Migrate those callers to
StyleX styles or explicit variants as part of an in-place component conversion when possible.
A temporary `customClassName` bridge can keep other callers working, but StyleX and Tailwind
classes on one element still compete in the cascade. Verify precedence and state behavior in
those callers; remove the bridge once they are migrated. If preserving them would broaden the
selected zone too far, keep the Tailwind component until a later zone.

## Convert `cva()` with its callers

Map the base string to a base style; each variant value to a style selected by a branch; defaults
to JS defaults; compound variants to a combined style that carries all states of overlapping
properties. Derive variant types from the StyleX style map so names cannot drift. `plan` places
checked candidate styles in `files[].source`, but that source may omit the base and skipped
classes. Compare it with every class in the original `cva()`; convert the missing base and resolve
its skips before using the result. `apply` leaves `cva()` definitions for manual conversion.
Replace each definition and its callers together.

A static branch can compile `stylex.props()` to class strings. A runtime lookup works too when
it reads better or the component already accepts runtime styles. Preserve existing variant
names, sizes, and defaults; a registry component's variants are not the local API contract.

Search for direct calls to the exported variant function too: it may style a link, menu trigger,
or other host outside the component. Convert those hosts with the function, or keep the legacy
function until they are in scope. A temporary StyleX peer can serve the selected zone while the
Tailwind component and variant function serve other routes.
