export type Styler = (text: string) => string;

const ansi =
  (on: string, off: string): Styler =>
  (text) =>
    text && `\x1b[${on}m${text}\x1b[${off}m`;
// Use 24-bit RGB so terminal palettes don't remap semantic colors.
const rgb = (hex: number) => ansi(`38;2;${hex >> 16};${(hex >> 8) & 255};${hex & 255}`, "39");

export const [amber, gray, dark, red] = [0xffaf00, 0x8a8a8a, 0x4e4e4e, 0xff5f5f].map(rgb);
export const bold = ansi("1", "22");
export const faint = ansi("2;3", "22;23");
export const PAD = "  ";

export const graphemes = new Intl.Segmenter();
export const displayWidth = (text: string) => Bun.stringWidth(text);

export function hardWrap(text: string, maxWidth: number) {
  return text.split("\n").flatMap((line) => {
    const rows = [""];
    for (const { segment } of graphemes.segment(line)) {
      if (rows.at(-1) && displayWidth(rows.at(-1) + segment) > maxWidth) rows.push("");
      rows[rows.length - 1] += segment;
    }
    return rows;
  });
}

// Word-wrap while preserving trailing spaces on each line so character offsets stay aligned with the source string.
function wordWrapRaw(text: string, maxWidth: number) {
  return text.split("\n").flatMap((line) => {
    const rows: string[] = [];
    for (const token of line.match(/\s*\S+\s*|\s+/g) ?? [""]) {
      const word = token.trimEnd();
      if (rows.length && displayWidth(rows.at(-1) + word) <= maxWidth) {
        rows[rows.length - 1] += token;
        continue;
      }
      const pieces = hardWrap(word, maxWidth);
      rows.push(...pieces.slice(0, -1), pieces.at(-1) + token.slice(word.length));
    }
    return rows;
  });
}

export const wordWrap = (text: string, maxWidth: number) => wordWrapRaw(text, maxWidth).map((row) => row.trimEnd());

export const hangIndent = (prefix: string, rows: string[]) =>
  rows.map((row, i) => (i ? row && " ".repeat(displayWidth(prefix)) + row : prefix + row));

const STYLE_BOLD = 1;
const STYLE_CODE = 2;
export const STYLE_THOUGHT = 4;

const applyStyle =
  (flags: number): Styler =>
  (text) => {
    if (flags & STYLE_CODE) text = gray(text);
    if (flags & STYLE_BOLD) text = bold(text);
    if (flags & STYLE_THOUGHT) text = faint(text);
    return text;
  };

type StyledText = { text: string; styles: number[] };

const tokenizeInline = (text: string) => text.match(/\*\*|`|[^]/g) ?? [];

function findUnclosedDelimiters(tokens: string[]) {
  const open = new Map<string, number>();
  for (const [i, token] of tokens.entries()) {
    if (token !== "`" && (token !== "**" || open.has("`"))) continue;
    if (open.has(token)) open.delete(token);
    else open.set(token, i);
  }
  return new Set(open.values());
}

// While streaming (complete=false), treat unclosed markers as active styles; once complete, render them literally.
function parseInlineMarkdown(text: string, complete: boolean, baseStyle = 0): StyledText {
  const tokens = tokenizeInline(text);
  const unclosed = findUnclosedDelimiters(tokens);
  const result: StyledText = { text: "", styles: [] };
  let style = baseStyle;
  tokens.forEach((token, i) => {
    const literal = unclosed.has(i) && complete;
    if (token === "`" && !literal) style ^= STYLE_CODE;
    else if (token === "**" && !(style & STYLE_CODE) && !literal) style ^= STYLE_BOLD;
    else for (const ch of token) ((result.text += ch), result.styles.push(style));
  });
  return result;
}

function renderStyledRows({ text, styles }: StyledText, maxWidth: number) {
  let offset = 0;
  return wordWrapRaw(text, maxWidth).map((row) => {
    const trimmed = row.trimEnd();
    let rendered = "";
    for (let start = 0, end = 1; start < trimmed.length; end++) {
      if (end < trimmed.length && styles[offset + end] === styles[offset + start]) continue;
      rendered += applyStyle(styles[offset + start])(trimmed.slice(start, end));
      start = end;
    }
    offset += row.length;
    return rendered;
  });
}

function renderProse(line: string, maxWidth: number, complete: boolean, baseStyle: number) {
  const heading = line.match(/^#{1,6}\s+(.*)/);
  const [, indent = "", bullet = "", body = line] = heading ? [] : (line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/) ?? []);
  const prefix = bullet && indent + (/\d/.test(bullet) ? bullet : "•") + " ";
  const styled = parseInlineMarkdown(heading?.[1] ?? body, complete, heading ? baseStyle | STYLE_BOLD : baseStyle);
  return hangIndent(
    applyStyle(baseStyle)(dark(prefix)),
    renderStyledRows(styled, Math.max(1, maxWidth - displayWidth(prefix))),
  );
}

export function renderCodeLine(line: string, maxWidth: number, styler: Styler) {
  const [, indent, body] = line.replace(/\t/g, "    ").match(/^(\s*)(.*)/)!;
  return hangIndent(indent, wordWrap(body, Math.max(1, maxWidth - indent.length)).map(styler));
}

const isFence = (line: string) => /^\s*```/.test(line);
const isTableRow = (line: string) => line.trimStart().startsWith("|");
const isTableRule = (line: string) => /^[\s|:-]+$/.test(line) && line.includes("-");
const splitTableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

function renderTable(lines: string[], maxWidth: number, complete: boolean, baseStyle: number) {
  const gap = PAD;
  const alignments = splitTableCells(lines.find(isTableRule) ?? "");
  const hasHeader = isTableRule(lines[1] ?? "");
  const rows = lines.filter((line) => !isTableRule(line)).map(splitTableCells);
  const cols = [...Array(Math.max(...rows.map((r) => r.length))).keys()];
  const parsed = rows.map((row, r) =>
    cols.map((c) => parseInlineMarkdown(row[c] ?? "", complete, hasHeader && !r ? baseStyle | STYLE_BOLD : baseStyle)),
  );
  const widths = cols.map((c) => Math.max(1, ...parsed.map((row) => displayWidth(row[c].text))));
  const totalWidth = () => widths.reduce((sum, w) => sum + w, 0);
  while (totalWidth() > maxWidth - gap.length * (cols.length - 1) && Math.max(...widths) > 1) {
    widths[widths.indexOf(Math.max(...widths))]--;
  }
  const alignCell = (text: string, c: number) => {
    const slack = widths[c] - displayWidth(text);
    const [left, right] = [alignments[c]?.startsWith(":"), alignments[c]?.endsWith(":")];
    const padLeft = right ? (left ? slack >> 1 : slack) : 0;
    return " ".repeat(padLeft) + text + " ".repeat(slack - padLeft);
  };
  return parsed.flatMap((row, r) => {
    const cellRows = row.map((cell, c) => renderStyledRows(cell, widths[c]));
    const height = Math.max(...cellRows.map((c) => c.length));
    const merged = [...Array(height).keys()].map((lineIdx) =>
      cols.map((c) => alignCell(cellRows[c][lineIdx] ?? "", c)).join(gap),
    );
    const divider = hasHeader && !r ? [applyStyle(baseStyle)(dark(widths.map((w) => "─".repeat(w)).join(gap)))] : [];
    return [...merged.map((line) => line.trimEnd()), ...divider];
  });
}

type BlockKind = "prose" | "code" | "table";
type MarkdownBlock = { kind: BlockKind; lines: string[]; gapBefore: boolean; complete: boolean };

function* parseBlocks(text: string, complete: boolean): Generator<MarkdownBlock> {
  const lines = text.split("\n");
  const findEnd = (from: number, predicate: (line: string) => boolean) => {
    const idx = lines.findIndex((line, i) => i >= from && predicate(line));
    return idx < 0 ? lines.length : idx;
  };
  let gapBefore = false;
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) {
      [gapBefore, i] = [true, i + 1];
      continue;
    }
    const kind: BlockKind = isFence(lines[i]) ? "code" : isTableRow(lines[i]) ? "table" : "prose";
    const end = {
      code: Math.min(lines.length, findEnd(i + 1, isFence) + 1),
      table: findEnd(i, (line) => !isTableRow(line)),
      prose: i + 1,
    }[kind];
    const nextStarted =
      end < lines.length - 1 || Boolean(lines[end]?.trim()) || (kind !== "table" && end < lines.length);
    yield { kind, lines: lines.slice(i, end), gapBefore, complete: complete || nextStarted };
    [gapBefore, i] = [false, end];
  }
}

function renderCodeBlock([, ...lines]: string[], maxWidth: number, baseStyle: number) {
  const body = isFence(lines.at(-1) ?? "") ? lines.slice(0, -1) : lines;
  return body.flatMap((line) => renderCodeLine(line, maxWidth, applyStyle(baseStyle | STYLE_CODE)));
}

const blockRenderers: Record<
  BlockKind,
  (lines: string[], maxWidth: number, complete: boolean, baseStyle: number) => string[]
> = {
  prose: ([line], maxWidth, complete, baseStyle) => renderProse(line, maxWidth, complete, baseStyle),
  code: (lines, maxWidth, _complete, baseStyle) => renderCodeBlock(lines, maxWidth, baseStyle),
  table: renderTable,
};

export type VoiceStyle = { style: number; blankBetweenBlocks: boolean };

export function renderMarkdown(text: string, maxWidth: number, complete: boolean, voice: VoiceStyle) {
  const rows: string[] = [];
  for (const block of parseBlocks(text, complete)) {
    const rendered = blockRenderers[block.kind](block.lines, maxWidth, block.complete, voice.style);
    if (rendered.length && block.gapBefore && voice.blankBetweenBlocks && rows.length) rows.push("");
    rows.push(...rendered);
  }
  return rows;
}
