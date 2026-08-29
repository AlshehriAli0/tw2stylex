# Reason codes

Every usage `tw2sx` skips carries one of these. The list is closed — if you see a code that is
not here, the tool is newer than this file.

Verify your fix by re-running `tw2sx plan <path>`. The skip should disappear and
`MISMATCHES` must stay at 0.

---

## `marker-class` — safe

`group`, `peer`, `group/name`, `peer/name`. Not utilities: they mark an element so *other*
elements can react to its state.

```tsx
// before
<div className="group flex">
  <span className="group-hover:text-blue-500">…</span>
</div>

// after
<div {...stylex.props(stylex.defaultMarker(), styles.row)}>
  <span {...stylex.props(styles.label)} />
</div>

const styles = stylex.create({
  row: { display: 'flex' },
  label: { color: { default: null, [stylex.when.ancestor(':hover')]: 'blue' } },
});
```

For a **named** group (`group/card`), you need a distinct marker. It must be a named export
from a `.stylex.ts` file — the compiler hashes it by file path plus export name:

```ts
// markers.stylex.ts
export const cardMarker = stylex.defineMarker();
```

Then `stylex.when.ancestor(':hover', cardMarker)`. Fix the `marker-class` skip and the
matching `sibling-state` skips together — they are two halves of one change.

---

## `sibling-state` — needs-lookup

`group-hover:`, `peer-checked:`, and friends. The element reacts to a *marked* ancestor or
sibling. Requires StyleX ≥ 0.18 for attribute selectors inside `when.*`.

| Tailwind | StyleX |
|---|---|
| `group-hover:x` | `[stylex.when.ancestor(':hover')]: x` |
| `group-data-[state=open]:x` | `[stylex.when.ancestor('[data-state="open"]')]: x` |
| `peer-checked:x` | `[stylex.when.siblingBefore(':checked')]: x` |
| `peer-focus:x` (either direction) | `[stylex.when.anySibling(':focus')]: x` |

**Placeholder to find:** the ancestor or sibling. It must carry `stylex.defaultMarker()` or your
named marker, or the style silently never applies. `anySibling`/`siblingAfter` compile to
`:has()`; the `no-lookahead-selectors` lint rule bans them if your project enables it.

---

## `parent-state` — needs-lookup

The element matches only under some ancestor — most often class-based dark mode, which
compiles to `&:is(.dark *)`.

**For dark mode, reach for theming** — it is the mechanism built for exactly this:

```ts
// tokens.stylex.ts
export const colors = stylex.defineVars({ text: 'black', surface: 'white' });
export const darkTheme = stylex.createTheme(colors, { text: 'white', surface: '#111' });
```

Apply `darkTheme` on the element that currently has `.dark`. Components then reference
`colors.text` unconditionally and dark mode just works.

If the project's tokens are already runtime CSS variables (e.g. `rgb(var(--primary))` from an
`@theme inline` block), you often need **no migration at all** — point `defineVars` at the same
variables and the existing runtime theming keeps working untouched.

For non-theme ancestor state, use `stylex.when.ancestor()` with a marker as above.

[tokens.md](./tokens.md) has the full dark-mode decision — `light-dark()` is usually simpler
than `createTheme`.

---

## `descendant-selector` — needs-lookup

`[&_svg]:size-4`, `[&>*]:p-2`, `[&_svg:not([class*='size-'])]:size-4`. StyleX styles one element
and hard-errors on descendant selectors. Style the child directly, or when the rule genuinely
needs to reach across elements, move it to a CSS Module beside the component.

**Placeholder to find:** the child. Style it directly.

```tsx
// before
<button className="[&_svg]:size-4 [&_svg]:shrink-0">{icon}</button>

// after — the icon gets its own style
<button {...stylex.props(styles.button)}>
  <Icon {...stylex.props(styles.icon)} />
</button>
const styles = stylex.create({ icon: { width: 16, height: 16, flexShrink: 0 } });
```

When the child is `{children}` and out of reach, pick one, in order of preference: give the
component an explicit slot prop for that child; have callers style it; or keep a CSS Module for
that one rule. If none fit, the rule stays and goes in your summary.

---

## `styles-children` — check-first

`space-x-*`, `space-y-*`, `divide-*`. These style *children* via `> :not(:last-child)`.

`space-y-4` → `{ display: 'flex', flexDirection: 'column', gap: 16 }` on the **parent**.

**Why check-first:** `gap` and `space-y` are not equivalent. `space-y` adds a margin between
adjacent children and does nothing to a wrapping row; `gap` applies to every gap including
across wrapped lines, and it requires flex or grid. If the parent is a plain block container
with `hidden` children, the two differ visibly. Check the parent's display before converting.

`divide-y` has no gap equivalent — put a border on the child:
`borderTopWidth: { default: 0, ':not(:first-child)': 1 }` plus `borderTopStyle: 'solid'`.

---

## `dropped-shorthand` — safe

Split into longhands. The skip's hint names them for the class in front of you; SKILL.md lists
them all.

`animate-*` is the one that needs more than a rename — define the keyframes:

```js
const spin = stylex.keyframes({ from: { transform: 'rotate(0)' }, to: { transform: 'rotate(360deg)' } });
const styles = stylex.create({
  spinner: { animationName: spin, animationDuration: '1s', animationTimingFunction: 'linear', animationIterationCount: 'infinite' },
});
```

`tw-animate-css` classes (`animate-in`, `fade-in`, `data-closed:animate-out`) all land here.
Enter/exit animations usually map better to a transition driven by the component's own state
attribute than to a keyframe.

---

## `shorthand-beaten-by-longhand` — check-first

One class sets a shorthand under a condition (`hover:p-8`, `@media (forced-colors: active)`),
another sets a longhand of the same box without it (`pt-2`). The two systems disagree on who
wins, and both are silent about it:

- **Tailwind** sorts by stylesheet order, so the conditional utility comes last and wins. On
  hover, `padding-top` takes the `hover:p-8` value.
- **StyleX** gives every longhand ID-level specificity (`.x1:not(#\#)`), so `paddingTop` wins in
  *every* state. The conditional shorthand never reaches that side.

The declaration sets match, which is why `plan` verifies everything else about these classes and
still skips them.

**Write the longhands, each carrying the condition:**

```js
// p-4 pt-2 hover:p-8
paddingTop:    { default: 8, ':hover': 32 },
paddingRight:  { default: 16, ':hover': 32 },
paddingBottom: { default: 16, ':hover': 32 },
paddingLeft:   { default: 16, ':hover': 32 },
```

If the longhand was the accident, delete that utility instead and let the shorthand convert.

`outline-hidden` trips this on its own: it sets `outline-style: none` and then a visible
`outline` under `@media (forced-colors: active)`. Converted as-is, the forced-colors fallback
never applies, so keep that one honest — it is an accessibility affordance, not decoration.

---

## `dynamic-classes` — check-first

A class string built at runtime: a ternary, `&&`, a template literal with interpolation, an
object map, or a call to something that is not a known merge helper.

Lift the condition out of the string and apply a style conditionally — `stylex.props`
ignores falsy arguments:

```tsx
// before
<div className={`flex ${isActive ? 'bg-blue-500' : 'bg-gray-200'}`} />
// after
<div {...stylex.props(styles.base, isActive ? styles.active : styles.inactive)} />

// before
<div className={cn('flex', isOpen && 'rotate-180')} />
// after
<div {...stylex.props(styles.base, isOpen && styles.open)} />
```

`tw2sx` reports the classes it could see on both branches, so you usually have everything you
need. **Interpolated values** (`` `text-[${color}]` ``) need a dynamic style function instead:
`highlight: (c) => ({ color: c })` — the body must be a bare object literal, not a block.

---

## `passed-in-classes` — check-first

A variable — almost always a `className` prop — flows into a class string. Converting the
component changes its public API, so this is never safe to do silently.

The end state is `style?: StyleXStylesWithout<{…}>`, with the `customClassName` bridge only
while unmigrated callers still pass strings. Full pattern in
[component-api.md](./component-api.md).

---

## `component-class-name` — needs-lookup

A `className` is applied to a custom component rather than a host element. Spreading
`stylex.props()` onto the component would not style the DOM it renders, so `tw2sx` leaves the
usage in place.

Convert the component first, then replace `className` with a typed StyleX `style` prop that the
component passes to its host element. The full contract is in
[component-api.md](./component-api.md).

---

## `unknown-class` — unknown

Tailwind itself does not recognise the class *in this project's design system*.

Usually one of: a plain CSS class that was never Tailwind (leave it alone — it needs no
migration); a class from a stylesheet `tw2sx` was not pointed at (pass `--css`); a missing
`@plugin`; or a typo that is already broken in production today.

Check with `tw2sx explain "<class>"` before assuming, and leave anything you cannot confirm
exactly as it is — `text-red-500` and `text-red-600` are one character apart and visibly
different, so a near-miss guess ships a design change.

---

## `two-style-sources` — check-first

The element carries a `className` beside its own `style` attribute, or beside a
`stylex.props()` spread that is already there.

Beside an existing spread, add the styles to that call: `stylex.props(styles.a, styles.b)`. A
class that is not Tailwind — `next/font`'s `inter.variable`, a class a markdown pipeline emits —
is joined onto the spread's own output, so the element still has one `className`:

```tsx
const sx = stylex.props(styles.body);
<body className={`${sx.className ?? ''} ${inter.variable}`} style={sx.style} />
```

If the inline style is static, fold it into the style. If it is genuinely dynamic, use a
dynamic style function and pass it through `stylex.props` so there is still only one source:

```tsx
// before
<div className="flex" style={{ width: w }} />
// after
<div {...stylex.props(styles.row, styles.width(w))} />

const styles = stylex.create({
  row: { display: 'flex' },
  width: (w: number) => ({ width: w }),   // body must be a bare object literal
});
```

---

## `unresolved-variable` — check-first

A `--tw-*` slot survived resolution with no value and no `@property` initial value. Tailwind
composes `box-shadow`, `filter`, `backdrop-filter` and `transform` from several classes at once;
if the whole set is not present on the element, the value is genuinely incomplete.

Resolve the element's full class set together and write one literal value. `tw2sx` already does
this when it can — reaching this code usually means a class is applied conditionally elsewhere.

---

## `unsupported-at-rule` — needs-lookup

An at-rule with no StyleX condition form, e.g. `@starting-style` from `starting:*`. Supported
at-rules are `@media`, `@supports` and `@container` (including named containers). Move anything
else to a plain CSS file.

---

## `lost-condition` — check-first

The generated StyleX compiled, but its declarations did not match Tailwind's — typically the overwriting problem: combining styles flattened a condition away (see SKILL.md).

Read the `mismatches` array in the JSON report: it names the exact
`(style, condition, property)` and both values. Fold the lost condition into the overriding
style, or restructure so the two styles do not both set that property.

---

## `variant-function` — safe

A call to a `cva()`-produced function `tw2sx` could not resolve to its definition, usually
because the definition sits in another file. Run `tw2sx plan` over the defining file too — the
converted styles are emitted there. Conversion recipe in
[component-api.md](./component-api.md).

---

## `important-modifier` — needs-lookup

Tailwind's `!` modifier (`p-4!`, v3's `!p-4`) emits `!important`, which StyleX has no form for.

**Placeholder to find:** whatever the `!` was written to beat — a vendor stylesheet, a base or
reset rule, or a competing utility on the same element. Finding it is the whole job: the style
compiles and looks right in isolation either way, so a wrong call surfaces only on the page
where it mattered.

With it in hand, one of two applies:

- **It is being migrated too** → drop the `!` and pass this style last to `stylex.props()`.
- **It stays outside StyleX** → the `!important` is load-bearing. Keep that one declaration in
  plain CSS and note it in your summary.

---

## `stylex-compile-error` — unknown

The StyleX we generated does not compile. **This is a tw2sx bug.** The detail carries the
compiler's own message.

Two moves, both of them: convert that one usage by hand from the Tailwind classes, and report
the class string that caused it. Working from the classes rather than from the broken output is
the point — what tw2sx produced is wrong at the source, so a patch that makes it compile ships
the wrong styles and hides the bug from the next person.
