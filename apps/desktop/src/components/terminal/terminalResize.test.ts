import { describe, expect, it } from "vitest";
import { readRepaint, spliceRepaint } from "./terminalResize";

// Claude Code 2.1.311's answer to a resize, as captured from its pty.
const erase = (rows: number) => "\x1b[H" + "\x1b[2K\x1b[1B".repeat(rows) + "\x1b[H";
const lead = "\x1b[?25l\x1b[2D\x1b[4B";
const tail = "\x1b[2C\x1b[4A\x1b[?25h";
const answer = (rows: number, lines: string[]) =>
  lead + erase(rows) + lines.map((l) => `\x1b[3G${l}\x1b[39m\r\r`).join("\n") + "\n" + tail;

const turn = [
  "⏺ First message, long enough to be found again",
  "  its second line",
  "",
  "⏺ Second message, also long enough to be found",
  "  wrapped once at the new width",
  "",
  "❯",
];

describe("readRepaint", () => {
  it("finds the repaint after the end of an earlier frame, and waits for all of it", () => {
    const earlier = "um\x1b[110G/effort\x1b[39m\r\r\n" + tail;
    const data = earlier + answer(5, turn);
    expect(readRepaint(data.slice(0, earlier.length + 20), 5)).toBeNull();
    expect(readRepaint(data.slice(0, -3), 5)).toBeNull();
    const repaint = readRepaint(data, 5)!;
    expect(repaint.before).toBe(earlier + lead);
    expect(repaint.lines).toHaveLength(turn.length + 1);
    expect(repaint.tail).toBe("\x1b[?25h");
  });

  it("ignores a shell's answer and an erase of another height", () => {
    expect(readRepaint("\r\x1b[K% ", 5)).toBeNull();
    expect(readRepaint(answer(4, turn), 5)).toBeNull();
  });
});

describe("spliceRepaint", () => {
  it("writes the repaint from the line the old top row starts, erasing from there down", () => {
    // The old screen starts at the second message; the first is in scrollback.
    const screen = ["⏺ Second message, also long enough to be found wrapped", "  once at the new width", "", "❯", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[1;1H\x1b[J");
    expect(repaint).not.toContain("First message");
    expect(repaint).toContain("Second message");
    expect(repaint.endsWith(tail)).toBe(true);
  });

  it("keeps old rows the repaint does not redraw, above the match", () => {
    const screen = ["an older line the repaint leaves out", "", "⏺ First message, long enough to be found again", "", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
    expect(repaint).toContain("First message");
  });

  it("skips a row whose text repeats, which could match the wrong copy", () => {
    const repeated = "⎿ Shell cwd was reset to /Users/someone/project";
    const screen = [repeated, "", "⏺ First message, long enough to be found again", repeated, ""];
    const { clear } = spliceRepaint(readRepaint(answer(5, [...turn, repeated]), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
  });

  it("with nothing to line up, writes the whole repaint below the old screen", () => {
    const screen = ["something else entirely, unrelated", "more of it, also unrelated text", "", "", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
    expect(repaint).toContain("First message");
  });
});
