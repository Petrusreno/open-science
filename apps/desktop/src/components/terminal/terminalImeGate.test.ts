import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { isModifierKey, releaseImeGate } from "./terminalKeys";

// macOS Pinyin, Shift held, Shift+/ typed twice: the IME commits "？" BEFORE
// the key's own keydown (xtermjs/xterm.js#6144, real-device trace).
function typeShiftedPunctuation(release: boolean): string[] {
  const term = new Terminal({ allowProposedApi: true });
  if (release) {
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && isModifierKey(event)) releaseImeGate(term);
      return true;
    });
  }
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  term.open(parent);
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  const ta = term.textarea!;
  const key = (type: string, init: KeyboardEventInit) =>
    ta.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  const commit = (data: string) => {
    ta.value += data;
    ta.dispatchEvent(new InputEvent("input", { data, inputType: "insertText", composed: true }));
  };

  key("keydown", { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true });
  for (let i = 0; i < 2; i++) {
    commit("？");
    key("keydown", { key: "？", code: "Slash", keyCode: 229, shiftKey: true });
    key("keyup", { key: "？", code: "Slash", keyCode: 191, shiftKey: true });
  }
  term.dispose();
  parent.remove();
  return sent;
}

describe("IME punctuation typed with Shift", () => {
  it("xterm still drops the first one on its own (remove the workaround once this fails)", () => {
    expect(typeShiftedPunctuation(false)).toEqual(["？"]);
  });

  it("reaches the shell on the first press once a modifier releases the gate", () => {
    expect(typeShiftedPunctuation(true)).toEqual(["？", "？"]);
  });
});
