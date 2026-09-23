# Map the project's styling system

Do this once before the first edit, then update the map for each migration zone. Start from the
project's actual files: package and build config, Tailwind entry and config, CSS imports,
component registry, theme setup, and the target route or component. Follow references to their
writers and consumers. A short working map is enough; the point is to make the next edit informed.

## Trace the foundations

Find and record:

- **Token ownership:** `@theme`, Tailwind config, CSS custom-property definitions, color formats,
  spacing, typography, breakpoints, and where components read them. Trace one color from its
  source through a rendered component in each relevant theme.
- **Theme writers and scopes:** dark or system switches, tenant or user themes, draft previews,
  subtree overrides, portals, and any script that calls `setProperty`. Identify the active
  writer and the variable format before creating StyleX tokens. `var(--primary)` is not a color
  when `--primary` contains only RGB channels; that project needs `rgb(var(--primary))`.
- **Cascade:** global CSS, resets, Tailwind plugins, CSS Modules, `@layer` order, inline styles,
  selectors that reach into children or third-party DOM, and custom utilities. `plan` checks
  declarations, not which rule wins on the page.
- **Component contracts:** local UI components, variants, `className` or `style` overrides,
  rendered primitives, refs, slots, portals, data attributes, and every caller of a shared
  component you might change.
- **Runtime behavior:** conditional classes, measured layout, theme values passed to charts or
  maps, hover/focus/disabled/open states, animation and transition sources, responsive rules,
  RTL, and reduced-motion handling where present.

## Bound the zone

Use the route, feature, or component the user selected. Record its imported components and its
outbound styling overrides. A shared component can move to StyleX during this zone if its
consumers and overrides are migrated or kept compatible. Otherwise keep it working in Tailwind
until its own zone; a StyleX page may temporarily render a Tailwind component. Convert only the
local UI components needed by the selected zone, not the whole component library on sight.
Within the zone, start with leaf components, then wrappers that pass styles or state through.

Classify each affected style before editing:

| Source | Migration path |
| --- | --- |
| Static Tailwind classes | `plan` then `apply`; resolve skips |
| Runtime condition or value | StyleX conditional/dynamic style, preserving the same states |
| Shared token or runtime theme | Keep the current source of truth; bridge or migrate ownership deliberately |
| Global rule or third-party DOM | Keep global CSS or move a local rule to scoped CSS |
| Inline layout from a library | Keep it if that library owns the value |

Done when each style source affecting the zone has an identified owner and migration path, and
you know which routes or consumers a shared edit can change. Capture the relevant current states
before editing so the check after migration has a real baseline.
