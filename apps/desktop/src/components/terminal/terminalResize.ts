/**
 * What a program printed right after being told its new size, and whether it
 * is Claude Code's full-screen repaint.
 *
 * Claude Code's classic renderer answers a resize by erasing exactly the
 * screen (`CSI H`, then `CSI 2K CSI 1B` once per row), homing again, and
 * printing its latest turn laid out for the new width, ending with
 * `CSI ?25h`. After a narrowing that turn is taller than the screen; the part
 * that scrolls off lands in scrollback, where the terminal already holds the
 * same turn, so every narrowing stacked one more copy of it
 * (anthropics/claude-code#51828).
 *
 * Only the last `rows` lines of such a repaint belong on the screen. The lines
 * above are already in scrollback, so they are dropped, all but their colour
 * changes, which the lines that stay may depend on.
 */
export type ResizeReply =
  /** Too little has arrived to tell. */
  | "wait"
  /** Anything else: write it as it is. */
  | "other"
  /** The repaint, cut to what fits on the screen. */
  | { repaint: string };

// eslint-disable-next-line no-control-regex -- escape sequences are the subject
const CONTROL_ONLY = /^(?:\x1b\[[0-9;?]*[A-Za-z])*(?:\x1b\[?[0-9;?]*)?$/; // may end mid-sequence
// eslint-disable-next-line no-control-regex -- as above
const COLOUR = /\x1b\[[0-9;]*m/g;
const SHOW_CURSOR = "\x1b[?25h";

export function readResizeReply(data: string, rows: number): ResizeReply {
  const head = new RegExp(
    `^(?:\\x1b\\[[0-9;?]*[A-Za-z])*?\\x1b\\[H(?:\\x1b\\[2K\\x1b\\[1B){${rows}}\\x1b\\[H`,
  ).exec(data);
  if (!head) return CONTROL_ONLY.test(data) ? "wait" : "other";
  const end = data.indexOf(SHOW_CURSOR, head[0].length);
  if (end < 0) return "wait";

  // The repaint starts on the top row, so `rows` lines fill the screen.
  const lines = data.slice(head[0].length, end).split("\n");
  const cut = lines.length - rows;
  if (cut <= 0) return { repaint: data };
  const colours = lines.slice(0, cut).join("").match(COLOUR) ?? [];
  return { repaint: head[0] + colours.join("") + lines.slice(cut).join("\n") + data.slice(end) };
}
