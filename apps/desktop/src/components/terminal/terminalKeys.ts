/**
 * Keys a native terminal sends differently from xterm.js out of the box, which
 * Claude Code, Codex and the shell's line editor rely on.
 *
 * - Shift+Enter → "\n" (line feed). xterm sends "\r", the same as Enter, so a
 *   CLI cannot tell them apart and Shift+Enter SENDS instead of starting a new
 *   line. A line feed is what Claude Code's own `/terminal-setup` makes iTerm2
 *   send, and what Claude Code and Codex read as "new line".
 * - macOS, left Option + a letter, digit or `. , / -` → Esc + that key: Meta,
 *   as iTerm2's "Esc+" setting gives it. Readline's word moves (Option+B/F/D)
 *   and Claude Code's Option+P / Option+T need it. Only the LEFT Option: the
 *   right one still composes, so layouts that type `@`, `€` or accents with
 *   Option keep them (why `macOptionIsMeta` stays off for the terminal).
 * - macOS, Cmd+← / Cmd+→ / Cmd+Backspace → start of line / end of line /
 *   delete to start (^A, ^E, ^U), as in any macOS text field and VS Code's
 *   terminal. xterm sends nothing for them.
 * - A modifier pressed on its own (⌘, Ctrl, Shift, Option, Caps Lock, Fn) never
 *   reaches xterm. It sends nothing, but with an input method on (Sogou,
 *   macOS Pinyin) WebKit reports it as an IME key (keyCode 229), which xterm
 *   treats as typing and scrolls to the bottom: pressing ⌘ to click a link or
 *   Ctrl on the way to Ctrl+O threw away the user's place in the scrollback.
 *   Matched on `code`, the physical key, since an IME key's `key` is unreliable.
 *
 * Everything else is left to xterm, which already encodes Option+←/→/⌫,
 * Option+Enter, Shift+Tab and the Ctrl keys the way a native terminal does.
 */

import type { Terminal } from "@xterm/xterm";

const MODIFIER_CODE = /^(?:(?:Meta|OS|Control|Shift|Alt)(?:Left|Right)|CapsLock|Fn|FnLock)$/;

/** A modifier pressed on its own, matched on the physical key. */
export function isModifierKey(event: KeyboardEvent): boolean {
  return MODIFIER_CODE.test(event.code);
}

/**
 * Call on a modifier's keydown. xterm 5.5 ignores IME text that arrives while
 * a keydown is "seen" and not yet released, and counts a modifier as one.
 * macOS Pinyin commits full-width punctuation typed with Shift (？：！（）《》)
 * BEFORE that key's own keydown, so with Shift held the first one was dropped
 * and had to be typed twice. A modifier types nothing, so it must not arm the
 * gate. Upstream: xtermjs/xterm.js#6144, fix in #6200; the test pins the
 * private field so an xterm upgrade that renames it fails loudly.
 */
export function releaseImeGate(term: Terminal): void {
  const core = (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core;
  if (core) core._keyDownSeen = false;
}

const META_PUNCTUATION: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Minus: "-",
};

/** The character a key stands for under Meta, from its physical position — on
 *  a Mac the event's `key` is already the composed glyph (Option+P is "π"). */
function metaChar(event: KeyboardEvent): string | null {
  const { code, shiftKey } = event;
  if (/^Key[A-Z]$/.test(code)) {
    const c = code.slice(3);
    return shiftKey ? c : c.toLowerCase();
  }
  if (shiftKey) return null;
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return META_PUNCTUATION[code] ?? null;
}

/**
 * A translator for one terminal. Call it with every event xterm's custom key
 * handler sees: it returns the bytes to send for a key it takes over, `false`
 * for an event that must not reach xterm (the keypress/keyup of a key already
 * taken), and `null` for everything xterm should handle as usual.
 */
export function createKeyTranslator(isMac: boolean) {
  // Which Option is down is only told by the Option key's own event.
  let leftOption = false;
  return (event: KeyboardEvent): string | false | null => {
    if (event.code === "AltLeft") leftOption = event.type === "keydown";
    // A window that lost focus with the key held never sees its keyup.
    else if (!event.altKey) leftOption = false;
    if (isModifierKey(event)) return event.type === "keydown" ? false : null;

    const data = translate(event);
    if (data === null) return null;
    return event.type === "keydown" ? data : false;
  };

  function translate(event: KeyboardEvent): string | null {
    const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
    if (key === "Enter" && shiftKey && !altKey && !ctrlKey && !metaKey) return "\n";
    if (!isMac) return null;
    if (metaKey && !altKey && !ctrlKey && !shiftKey) {
      if (key === "ArrowLeft") return "\x01";
      if (key === "ArrowRight") return "\x05";
      if (key === "Backspace") return "\x15";
      return null;
    }
    if (altKey && leftOption && !ctrlKey && !metaKey) {
      const c = metaChar(event);
      return c === null ? null : `\x1b${c}`;
    }
    return null;
  }
}
