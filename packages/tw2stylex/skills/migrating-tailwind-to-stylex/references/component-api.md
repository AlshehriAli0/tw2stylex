# Component API

For components that accept styling from callers, and for `cva`. Reached from
`passed-in-classes`, `variant-function`, and the overwriting rule in SKILL.md.

**Styling at a distance should fail to compile.** Tailwind made it free to reach into a
component from outside and restyle it, so codebases grow thousands of those reaches. Convention
will not hold them back. Every rule below moves the boundary into the type system, where the
call site errors instead of the pixel quietly changing.

## Ban the properties the component owns

A component's `style` prop is typed with `StyleXStylesWithout`, listing every property the
component sets itself. Overwriting then fails to compile at the call site instead of silently
killing a `:hover` rule at runtime.

```tsx
const styles = stylex.create({ base: { display: 'inline-flex', borderRadius: 6 } });
const variants = stylex.create({
  default: { backgroundColor: { default: 'blue', ':hover': 'darkblue' }, color: 'white' },
  ghost:   { backgroundColor: { default: null,   ':hover': 'gainsboro' }, color: 'black' },
});

type ButtonVariant = keyof typeof variants;          // derived; the union cannot drift

type ButtonProps = Omit<React.ComponentProps<'button'>, 'style'> & {
  variant?: ButtonVariant;
  style?: StyleXStylesWithout<{ backgroundColor: string; color: string }>;
};

export function Button({ variant = 'default', style, ...props }: ButtonProps) {
  return <button {...props} {...stylex.props(styles.base, variants[variant], style)} />;
}
```

Verified: `<Button style={ok.spacing} />` compiles, `<Button style={bad.background} />` and
`variant="nope"` both error.

Two details that fail to compile if you get them wrong:

- The banned map takes **concrete CSS types** (`{ backgroundColor: string }`). `unknown` trips
  StyleX's `NotUndefined` constraint.
- `Omit<…, 'style'>` on the DOM props, or React's `CSSProperties` collides with the StyleX prop.

Callers who need an owned property go through a variant.

## Caller styles keep their place

`stylex.props()` is last-wins per property, so argument order *is* the precedence rule: local
styles first, the caller's `style` prop last.

## While unmigrated callers still pass className

A component mid-migration still receives Tailwind strings. This bridges them so nothing breaks:

```ts
// Scaffolding. Delete once no caller passes a className string.
export const customClassName = (c?: string) =>
  c ? ({ [c]: c, $$css: true } as StyleXStyles) : null;
```

Pass it **before** the `style` prop so caller StyleX still wins. Each surviving bridge is what
keeps Tailwind in the build, so treat the count of them as the migration's remaining distance.

## Converting cva

`cva()` maps onto StyleX's documented variants recipe — a style per variant value plus a
lookup. There is no `stylex.variants()` API.

| cva | StyleX |
|---|---|
| `base` string | a `base` style, first argument to `stylex.props` |
| `variants.axis.value` | a style, picked by branching on the axis (below) |
| `defaultVariants` | JS default parameter values |
| `VariantProps<typeof x>` | `keyof typeof variants` |
| `props.className` (last) | the `style` prop, last |

For **compound variants**, StyleX's docs say to pre-flatten the combination into its own
style (`colorVariantsDisabled`) and select it, rather than layering a second style over
the first. Layering is what wipes the conditions.

`tw2stylex` converts cva mechanically and names styles from the axis and value.

### Branch on the variant

When every variant value is known and nothing else about the style is dynamic, write one
`stylex.props` call per branch:

```tsx
const variantProps = variant === 'ghost'
  ? stylex.props(styles.base, variants.ghost)
  : stylex.props(styles.base, variants.default);

return <button {...props} {...variantProps} />;
```

Static branches compile away to literal class strings; a lookup like `variants[variant]` gives
the same CSS but keeps the style objects and a runtime `stylex.props` call in the bundle. Three
or more values: a `switch` with one `stylex.props` call per case. If the component already
takes a runtime `style` prop, the runtime path exists anyway — use whichever reads better.

## Advertise only what you apply

A component that accepts a `style` prop must merge it, after its own styles, onto the element a
caller would expect to hit. Taking the prop and dropping it is worse than not taking it: the
caller's styles vanish with no error, and the type signature said they would work.

The same goes the other way. A `size` or `variant` prop the component only half-applies teaches
callers a contract it does not keep. One styling interface per component, honoured completely.
