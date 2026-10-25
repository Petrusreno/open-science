import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { activateLink, linkCandidates, resolveLink, type LinkSpan, type LinkTarget } from "@/lib/links";

/** One row's text, with the cell each UTF-16 unit of it sits in. A wide (CJK)
 *  character takes two cells, so a string index is not a column. */
export function rowText(line: Pick<IBufferLine, "length" | "getCell">): {
  text: string;
  cells: { x: number; width: number }[];
} {
  let text = "";
  const cells: { x: number; width: number }[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // the second half of a wide character
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cells.push({ x, width });
    text += chars;
  }
  return { text, cells };
}

/** One buffer row as the link finder reads it. `wrapped`: the terminal itself
 *  continued the previous row here (the line was longer than the width). */
export interface Row {
  text: string;
  cells: { x: number; width: number }[];
  wrapped: boolean;
}

/** A printed line put back together from the rows it was broken over. */
export interface LogicalLine {
  text: string;
  /** The cell (and 1-based row) of each UTF-16 unit of `text`. */
  cells: { x: number; y: number; width: number }[];
  /** Where a TUI broke the line itself: the next row's text starts at `at`.
   *  `nearEdge` — the row before ran up to the right edge, so a break there is
   *  almost certainly a wrap and not the end of a sentence. */
  breaks: { at: number; nearEdge: boolean }[];
}

/** How far a line is followed up and down. A path or URL longer than this
 *  many rows is not worth the lookups. */
const MAX_ROWS = 8;
/** A row whose text ends within this many columns of the right edge "ran into
 *  it". TUIs wrap a little short of the terminal width (margins, a scrollbar). */
const EDGE_COLUMNS = 8;
/** Characters a path or URL can end or start a row with. */
const LINK_CHAR = /[\w.@+\-/~%#=&?:\u00c0-\u2fff\u3040-\ufeff]/;

/**
 * The line row `y` is part of. Rows join when the terminal wrapped them, or
 * when a TUI did — Claude Code, Codex and the like break long lines with a
 * newline and indent the rest, so a long path arrives as several unrelated
 * rows. A TUI break is assumed wherever one row ends and the next begins with
 * a character a link can contain; a span that crosses one is only kept if it
 * resolves (see `registerTerminalLinks`), so a wrong guess costs a lookup.
 */
export function logicalLine(row: (y: number) => Row | null, y: number, cols: number): LogicalLine {
  const trimEnd = (r: Row) => r.text.replace(/\s+$/, "");
  /** How row `b` continues row `a`: soft, hard (a TUI break), or not at all. */
  const join = (a: Row, b: Row): "soft" | "hard" | null => {
    if (b.wrapped) return "soft";
    const end = trimEnd(a);
    const start = b.text.trimStart();
    if (!end || !start) return null;
    return LINK_CHAR.test(end[end.length - 1]) && LINK_CHAR.test(start[0]) ? "hard" : null;
  };

  let first = y;
  for (let n = 0; n < MAX_ROWS; n++) {
    const above = row(first - 1);
    const here = row(first);
    if (!above || !here || !join(above, here)) break;
    first--;
  }
  const out: LogicalLine = { text: "", cells: [], breaks: [] };
  let prev: Row | null = null;
  for (let r = first; r <= y + MAX_ROWS; r++) {
    const cur = row(r);
    if (!cur) break;
    let from = 0;
    if (prev) {
      const how = join(prev, cur);
      if (!how) break;
      if (how === "hard") {
        // Drop the previous row's trailing blanks and this row's indent.
        const dropped = prev.text.length - trimEnd(prev).length;
        out.text = out.text.slice(0, out.text.length - dropped);
        out.cells.length -= dropped;
        const last = out.cells[out.cells.length - 1];
        out.breaks.push({ at: out.text.length, nearEdge: last.x + last.width >= cols - EDGE_COLUMNS });
        from = cur.text.length - cur.text.trimStart().length;
      }
    }
    out.text += cur.text.slice(from);
    for (let i = from; i < cur.text.length; i++) out.cells.push({ ...cur.cells[i], y: r });
    prev = cur;
  }
  return out;
}

/** The candidates in a logical line, as the plain row-by-row reading would see
 *  them plus the longer ones that cross a TUI break. A URL crosses a break only
 *  where the row ran up to the edge: a URL cannot be checked, and a URL ending
 *  one line of prose would otherwise swallow the first word of the next. */
export function lineCandidates(line: LogicalLine): LinkSpan[] {
  const bounds = [0, ...line.breaks.map((b) => b.at), line.text.length];
  const spans: LinkSpan[] = [];
  const add = (span: LinkSpan) => {
    if (!spans.some((s) => s.start === span.start && s.end === span.end)) spans.push(span);
  };
  for (const span of linkCandidates(line.text)) {
    const crossed = line.breaks.filter((b) => b.at > span.start && b.at < span.end);
    if (span.kind === "url" && crossed.some((b) => !b.nearEdge)) continue;
    add(span);
  }
  for (let i = 0; i + 1 < bounds.length; i++) {
    const piece = line.text.slice(bounds[i], bounds[i + 1]);
    for (const span of linkCandidates(piece)) {
      add({ ...span, start: span.start + bounds[i], end: span.end + bounds[i] });
    }
  }
  return spans;
}

/** Of the spans that resolved, the longest win; the rest must not overlap them. */
export function pickLongest<T extends { start: number; end: number }>(found: T[]): T[] {
  const picked: T[] = [];
  for (const span of [...found].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (!picked.some((p) => span.start < p.end && p.start < span.end)) picked.push(span);
  }
  return picked;
}

/**
 * URLs and existing local paths in a terminal become links (see lib/links):
 * xterm underlines one under the pointer, and a click opens the link menu.
 * A link may run over several rows (see `logicalLine`). `cwd` is read at hover
 * time — the shell moves — so relative paths resolve where the user is now.
 */
export function registerTerminalLinks(term: Terminal, cwd: () => string | null) {
  const row = (y: number): Row | null => {
    const line = term.buffer.active.getLine(y - 1);
    return line ? { ...rowText(line), wrapped: line.isWrapped } : null;
  };
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = logicalLine(row, y, term.cols);
      const spans = lineCandidates(line);
      if (spans.length === 0) return callback(undefined);
      const from = { cwd: cwd() };
      void Promise.all(
        spans.map(async (span) => {
          const target = await resolveLink(span.text, from);
          return target ? { span, target } : null;
        }),
      ).then((resolved) => {
        const found = resolved.filter((r): r is { span: LinkSpan; target: LinkTarget } => r !== null);
        const links: ILink[] = pickLongest(found.map((r) => ({ ...r, start: r.span.start, end: r.span.end })))
          .map(({ span, target }) => {
            const first = line.cells[span.start];
            const last = line.cells[span.end - 1];
            return {
              // 1-based, end inclusive — the last cell of the last character.
              range: { start: { x: first.x + 1, y: first.y }, end: { x: last.x + last.width, y: last.y } },
              text: span.text,
              decorations: { underline: true, pointerCursor: true },
              activate: (event: MouseEvent) => activateLink(target, event),
            };
          })
          // xterm asks row by row; answer with the links on this one.
          .filter((l) => l.range.start.y <= y && y <= l.range.end.y);
        callback(links.length ? links : undefined);
      });
    },
  });
}
