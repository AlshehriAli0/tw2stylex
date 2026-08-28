# Component API

For components that accept styling from callers, and for `cva`. Reached from
`contract-change`, `cva-call`, and the erasure rule in SKILL.md.

## Ban the properties the component owns

A component's `style` prop is typed with `StyleXStylesWithout`, listing every property the
component sets itself. Erasure then fails to compile at the call site instead of silently
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

Callers who need an owned property go through a variant. That friction is the point — restyling
components through wrappers is the habit this migration ends.

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

`cva()` maps onto StyleX's documented variants recipe — a namespace per variant value plus a
lookup. There is no `stylex.variants()` API.

| cva | StyleX |
|---|---|
| `base` string | a `base` namespace, first argument to `stylex.props` |
| `variants.axis.value` | a namespace, selected by `variants[axis]` |
| `defaultVariants` | JS default parameter values |
| `VariantProps<typeof x>` | `keyof typeof variants` |
| `props.className` (last) | the `style` prop, last |

For **compound variants**, StyleX's docs say to pre-flatten the combination into its own
namespace (`colorVariantsDisabled`) and select it, rather than layering a second namespace over
the first. Layering is what triggers erasure.

`tw2sx` converts cva mechanically and names namespaces from the axis and value. Plain JSX sites
get `el1`, `el2` placeholders — rename those to what the element is while you review the file.
