# StyleX authoring limits

Read this when resolving skips or writing a StyleX peer by hand. Check the installed StyleX
version against [Thinking in StyleX](https://stylexjs.com/docs/learn/thinking-in-stylex) and
the [authoring guide](https://raw.githubusercontent.com/facebook/stylex/main/packages/docs/static/llm/stylex-authoring.md)
for APIs not covered here.

- **Merging is per property.** In `stylex.props(base, override)`, a later flat
  `backgroundColor` removes the earlier property's hover and other conditions. Put all states
  of an overridden property in one style or make the override an explicit variant.
- **Conditions belong inside a property value** and need `default` (use `null` if absent):
  `color: { default: 'blue', ':hover': 'red' }`. A top-level `':hover'` style object is dropped.
- **Use supported longhands.** `background`, `border`, `animation`, `all`, and directional
  border shorthands compile to nothing. Conditional padding/margin shorthands can lose to
  longhands; write each affected longhand with its states.
- **Compose precedence explicitly.** StyleX has no `!important`; the later style in
  `stylex.props()` wins the property. Check CSS layer precedence separately when Tailwind or
  plain CSS shares the element.
- **One element, one merged styling result.** Compose StyleX styles in one `stylex.props()`
  call. A separate `className` or `style` prop can overwrite that output; merge deliberately
  when a legacy or library-owned class must stay.
- **Host elements apply StyleX.** A spread onto `<MyButton>` does not reach its DOM node;
  pass a typed style prop and merge it where the component renders.
- **Static values are literals or StyleX tokens.** Imported ordinary constants can be dropped
  during compilation. Import `.stylex.ts` token files directly; barrel re-exports can break
  static analysis. Define shared keyframes through a token, as keyframes are file-local.
- **An element may read surrounding state, but cannot style another element.** Move child
  styles to that child. Keep rules for global or third-party DOM in global/scoped CSS, including
  unsupported at-rules such as `@starting-style`. A `:has(> child)` condition still styles the
  current element and can remain in StyleX.

For a skip, follow [reason-codes.md](reason-codes.md) for the exact conversion and its edge
cases. Rename generated tag-based style names to their role, reuse identical entries, keep
styles beside the markup that uses them, and prefer existing project tokens to new literals.
Build output and rendered states are the checks for silently dropped StyleX rules.
