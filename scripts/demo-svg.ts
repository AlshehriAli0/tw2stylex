/**
 * Renders coloured CLI output to assets/demo.svg, so the README shows what the terminal shows.
 * Usage: FORCE_COLOR=1 tw2sx plan app | bun run scripts/demo-svg.ts > assets/demo.svg
 */
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[(\\d+)m`, "g");

const PALETTE: Record<string, string> = {
  "31": "#f87171",
  "32": "#4ade80",
  "33": "#fbbf24",
  "34": "#60a5fa",
  "35": "#c084fc",
  "36": "#22d3ee",
};

const BACKGROUND = "#0d1117";
const FOREGROUND = "#c9d1d9";
const LINE_HEIGHT = 19;
const CHAR_WIDTH = 8.4;
const PADDING = 20;

type Span = { text: string; fill: string; bold: boolean; dim: boolean };

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const spansOf = (line: string): Span[] => {
  const spans: Span[] = [];
  let fill = FOREGROUND;
  let bold = false;
  let dim = false;
  let at = 0;

  for (const match of line.matchAll(SGR)) {
    const start = match.index;
    if (start > at) spans.push({ text: line.slice(at, start), fill, bold, dim });
    const code = match[1] ?? "0";
    if (code === "1") bold = true;
    else if (code === "2") dim = true;
    else if (code === "22") bold = dim = false;
    else if (code === "39") fill = FOREGROUND;
    else fill = PALETTE[code] ?? FOREGROUND;
    at = start + match[0].length;
  }
  if (at < line.length) spans.push({ text: line.slice(at), fill, bold, dim });
  return spans.filter(s => s.text.length > 0);
};

const tspan = (span: Span, column: number): string => {
  const weight = span.bold ? ' font-weight="600"' : "";
  const opacity = span.dim ? ' opacity="0.55"' : "";
  const x = PADDING + column * CHAR_WIDTH;
  return `<tspan x="${x.toFixed(1)}"${weight}${opacity} fill="${span.fill}">${escapeXml(span.text)}</tspan>`;
};

const rowOf = (line: string, index: number): string => {
  let column = 0;
  const parts = spansOf(line).map(span => {
    const rendered = tspan(span, column);
    column += span.text.length;
    return rendered;
  });
  const y = PADDING + (index + 1) * LINE_HEIGHT;
  return `<text y="${y}">${parts.join("")}</text>`;
};

const widthOf = (lines: string[]): number => Math.max(...lines.map(l => l.replace(SGR, "").length));

export const render = (input: string): string => {
  const lines = input.replace(/\n$/, "").split("\n");
  const width = Math.ceil(widthOf(lines) * CHAR_WIDTH + PADDING * 2);
  const height = lines.length * LINE_HEIGHT + PADDING * 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${BACKGROUND}"/>`,
    `<g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="13.5" fill="${FOREGROUND}">`,
    ...lines.map(rowOf),
    `</g></svg>`,
  ].join("\n");
};

process.stdout.write(render(await Bun.stdin.text()));
