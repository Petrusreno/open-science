import { describe, expect, it } from "vitest";
import { lineCandidates, logicalLine, pickLongest, rowText } from "./terminalLinks";

/** A fake xterm row: each entry is one cell's characters, "" for the second
 *  half of a wide character. */
function row(cells: string[]) {
  return {
    length: cells.length,
    getCell: (x: number) => {
      const c = cells[x];
      if (c === undefined) return undefined;
      const wide = cells[x + 1] === "";
      return { getChars: () => c, getWidth: () => (c === "" ? 0 : wide ? 2 : 1) } as never;
    },
  };
}

describe("rowText", () => {
  it("maps each character to its cell, wide characters taking two", () => {
    const { text, cells } = rowText(row(["中", "", "a", "/", "b"]));
    expect(text).toBe("中a/b");
    expect(cells).toEqual([
      { x: 0, width: 2 },
      { x: 2, width: 1 },
      { x: 3, width: 1 },
      { x: 4, width: 1 },
    ]);
  });
});

/** Rows as text, one cell per character, padded to `cols` like a real buffer.
 *  A leading "↪" marks a row the terminal itself wrapped onto. */
function screen(lines: string[], cols: number) {
  const rows = lines.map((l) => {
    const wrapped = l.startsWith("↪");
    const text = (wrapped ? l.slice(1) : l).padEnd(cols, " ");
    return { text, cells: [...text].map((_, x) => ({ x, width: 1 })), wrapped };
  });
  return (y: number) => rows[y - 1] ?? null;
}

describe("logicalLine", () => {
  const cols = 40;

  it("puts back a path a TUI broke over two indented rows, from either row", () => {
    const rows = screen(
      [
        "● Open: /Users/me/Documents/projects/d",
        "  sh-notes/dsh-principles.html",
        "",
        "  Next paragraph",
      ],
      cols,
    );
    for (const y of [1, 2]) {
      const line = logicalLine(rows, y, cols);
      expect(line.text.trimEnd()).toBe("● Open: /Users/me/Documents/projects/dsh-notes/dsh-principles.html");
      expect(line.breaks).toEqual([{ at: 38, nearEdge: true }]);
      const spans = lineCandidates(line).map((s) => s.text);
      expect(spans).toContain("/Users/me/Documents/projects/dsh-notes/dsh-principles.html");
      // The row-by-row pieces stay candidates, for when the whole does not resolve.
      expect(spans).toContain("/Users/me/Documents/projects/d");
      expect(spans).toContain("sh-notes/dsh-principles.html");
    }
    // The second row's characters keep their own cells.
    const line = logicalLine(rows, 2, cols);
    expect(line.cells[38]).toEqual({ x: 2, y: 2, width: 1 });
  });

  it("joins rows the terminal wrapped as they are", () => {
    const rows = screen(["/Users/me/a-very-long-folder-name/and-a-", "↪file.txt"], cols);
    const line = logicalLine(rows, 2, cols);
    expect(line.text.trimEnd()).toBe("/Users/me/a-very-long-folder-name/and-a-file.txt");
    expect(line.breaks).toEqual([]);
  });

  it("does not join across a blank row or sentence punctuation", () => {
    expect(logicalLine(screen(["see notes/", "", "x/y"], cols), 1, cols).text.trim()).toBe("see notes/");
    expect(logicalLine(screen(["done (a/b)", "next/c"], cols), 2, cols).text.trim()).toBe("next/c");
  });

  it("lets a URL cross a break only where the row ran up to the edge", () => {
    const short = logicalLine(screen(["see https://a.com", "for details"], cols), 1, cols);
    expect(lineCandidates(short).map((s) => s.text)).toEqual(["https://a.com"]);
    const full = logicalLine(screen(["see https://example.com/a/very/long/pa", "  th/to/page"], cols), 1, cols);
    expect(lineCandidates(full).map((s) => s.text)).toContain("https://example.com/a/very/long/path/to/page");
  });
});

describe("pickLongest", () => {
  it("keeps the longest of overlapping spans", () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 0, end: 30 },
      { start: 12, end: 30 },
      { start: 31, end: 35 },
    ];
    expect(pickLongest(spans)).toEqual([
      { start: 0, end: 30 },
      { start: 31, end: 35 },
    ]);
  });
});
