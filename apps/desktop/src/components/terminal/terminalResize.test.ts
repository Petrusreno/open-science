import { describe, expect, it } from "vitest";
import { readResizeReply } from "./terminalResize";

// Claude Code 2.1.311's answer to a resize, as captured from its pty.
const head = (rows: number) =>
  "\x1b[?25l\x1b[2D\x1b[4B\x1b[H" + "\x1b[2K\x1b[1B".repeat(rows) + "\x1b[H";
const tail = "\x1b[2C\x1b[4A\x1b[?25h";
const frame = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `\x1b[3${i % 8}mline ${i}\x1b[39m\r\r\n`).join("");

describe("readResizeReply", () => {
  it("keeps only the last screenful of a repaint taller than the screen, and its colours", () => {
    const read = readResizeReply(head(5) + frame(8) + tail, 5);
    expect(read).not.toBe("wait");
    expect(read).not.toBe("other");
    const repaint = (read as { repaint: string }).repaint;
    expect(repaint.startsWith(head(5))).toBe(true);
    expect(repaint.endsWith(tail)).toBe(true);
    // 8 lines plus the cursor row: the first 4 are already in scrollback.
    const body = repaint.slice(head(5).length, -tail.length);
    expect(body.split("\n")).toHaveLength(5);
    expect(body).not.toContain("line 3");
    expect(body).toContain("line 4");
    expect(body).toContain("\x1b[33m");
  });

  it("leaves a repaint that fits as it is", () => {
    const data = head(5) + frame(4) + tail;
    expect(readResizeReply(data, 5)).toEqual({ repaint: data });
  });

  it("waits for the rest of a repaint split across chunks", () => {
    const data = head(5) + frame(8) + tail;
    expect(readResizeReply(data.slice(0, 20), 5)).toBe("wait");
    expect(readResizeReply(data.slice(0, head(5).length + 30), 5)).toBe("wait");
  });

  it("does not take a shell's answer, or an erase of the wrong height, for a repaint", () => {
    expect(readResizeReply("\r\x1b[K% ", 5)).toBe("other");
    expect(readResizeReply(head(4) + frame(8) + tail, 5)).toBe("other");
  });
});
