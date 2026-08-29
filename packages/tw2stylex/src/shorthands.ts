import type { Skip } from "./skip.ts";

const sides = (prefix: string, suffix = ""): string[] => [
  `${prefix}Top${suffix}`,
  `${prefix}Right${suffix}`,
  `${prefix}Bottom${suffix}`,
  `${prefix}Left${suffix}`,
  `${prefix}InlineStart${suffix}`,
  `${prefix}InlineEnd${suffix}`,
  `${prefix}BlockStart${suffix}`,
  `${prefix}BlockEnd${suffix}`,
];

const box = (prefix: string): Record<string, string[]> => ({
  [prefix]: [`${prefix}Inline`, `${prefix}Block`, ...sides(prefix)],
  [`${prefix}Inline`]: [
    `${prefix}InlineStart`,
    `${prefix}InlineEnd`,
    `${prefix}Left`,
    `${prefix}Right`,
  ],
  [`${prefix}Block`]: [
    `${prefix}BlockStart`,
    `${prefix}BlockEnd`,
    `${prefix}Top`,
    `${prefix}Bottom`,
  ],
});

const corners = (suffix: string): string[] => [
  `borderTopLeft${suffix}`,
  `borderTopRight${suffix}`,
  `borderBottomLeft${suffix}`,
  `borderBottomRight${suffix}`,
  `borderStartStart${suffix}`,
  `borderStartEnd${suffix}`,
  `borderEndStart${suffix}`,
  `borderEndEnd${suffix}`,
];

export const LONGHANDS_OF: Record<string, string[]> = {
  ...box("padding"),
  ...box("margin"),
  ...box("scrollPadding"),
  ...box("scrollMargin"),
  inset: ["insetInline", "insetBlock", "top", "right", "bottom", "left"],
  insetInline: ["insetInlineStart", "insetInlineEnd", "left", "right"],
  insetBlock: ["insetBlockStart", "insetBlockEnd", "top", "bottom"],
  borderRadius: corners("Radius"),
  borderWidth: sides("border", "Width"),
  borderStyle: sides("border", "Style"),
  borderColor: sides("border", "Color"),
  flex: ["flexGrow", "flexShrink", "flexBasis"],
  flexFlow: ["flexDirection", "flexWrap"],
  gap: ["rowGap", "columnGap"],
  overflow: ["overflowX", "overflowY"],
  overscrollBehavior: ["overscrollBehaviorX", "overscrollBehaviorY"],
  placeItems: ["alignItems", "justifyItems"],
  placeContent: ["alignContent", "justifyContent"],
  placeSelf: ["alignSelf", "justifySelf"],
  outline: ["outlineWidth", "outlineStyle", "outlineColor"],
  font: [
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "lineHeight",
    "fontFamily",
  ],
  textDecoration: [
    "textDecorationLine",
    "textDecorationColor",
    "textDecorationStyle",
    "textDecorationThickness",
  ],
  gridArea: [
    "gridRow",
    "gridColumn",
    "gridRowStart",
    "gridRowEnd",
    "gridColumnStart",
    "gridColumnEnd",
  ],
  gridRow: ["gridRowStart", "gridRowEnd"],
  gridColumn: ["gridColumnStart", "gridColumnEnd"],
  gridTemplate: ["gridTemplateRows", "gridTemplateColumns", "gridTemplateAreas"],
  containIntrinsicSize: ["containIntrinsicWidth", "containIntrinsicHeight"],
};

type Grouped = Map<string, { path: string[]; props: Map<string, string> }>;

type Beaten = {
  shorthand: string;
  longhand: string;
  condition: string;
  setter: string;
  beater: string;
};

const propertiesIn = (declarations: Grouped): Set<string> => {
  const all = new Set<string>();
  for (const group of declarations.values())
    for (const property of group.props.keys()) all.add(property);
  return all;
};

const beatenIn = (
  props: Map<string, string>,
  present: Set<string>,
): Array<Pick<Beaten, "shorthand" | "longhand">> =>
  [...props.keys()].flatMap(shorthand =>
    (LONGHANDS_OF[shorthand] ?? [])
      .filter(longhand => present.has(longhand) && !props.has(longhand))
      .map(longhand => ({ shorthand, longhand })),
  );

const nameOf = (setBy: Map<string, string>, key: string, property: string): string =>
  setBy.get(`${key}|${property}`) ?? property;

const classThatSet = (declarations: Grouped, setBy: Map<string, string>, prop: string): string => {
  for (const [key, group] of declarations)
    if (group.props.has(prop)) return nameOf(setBy, key, prop);
  return prop;
};

const conflictsIn = (declarations: Grouped, setBy: Map<string, string>): Beaten[] => {
  const present = propertiesIn(declarations);
  const found: Beaten[] = [];
  for (const [key, group] of declarations) {
    if (group.path.length === 0) continue;
    for (const { shorthand, longhand } of beatenIn(group.props, present))
      found.push({
        shorthand,
        longhand,
        condition: group.path.join(" "),
        setter: nameOf(setBy, key, shorthand),
        beater: classThatSet(declarations, setBy, longhand),
      });
  }
  return found;
};

const skipFor = ({ shorthand, longhand, condition, setter, beater }: Beaten): Skip => ({
  reason: "shorthand-beaten-by-longhand",
  class: setter,
  detail:
    `"${setter}" sets ${shorthand} under "${condition}", while "${beater}" sets ${longhand} ` +
    `outside it. StyleX ranks a longhand above a conditional shorthand, so ${longhand} keeps ` +
    `its own value in that state; in Tailwind the conditional rule wins.`,
  hint:
    `Write the longhands ${shorthand} covers, each carrying the condition — or drop the ` +
    `${longhand} utility if the conditional shorthand was meant to win.`,
});

export const beatenShorthands = (declarations: Grouped, setBy: Map<string, string>): Skip[] =>
  conflictsIn(declarations, setBy).map(skipFor);
