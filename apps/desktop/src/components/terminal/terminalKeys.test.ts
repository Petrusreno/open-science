import { describe, expect, it } from "vitest";
import { createKeyTranslator } from "./terminalKeys";

const key = (init: KeyboardEventInit & { type?: string }) =>
  new KeyboardEvent(init.type ?? "keydown", init);

describe("terminal keys", () => {
  it("Shift+Enter starts a new line instead of sending", () => {
    for (const mac of [true, false]) {
      const t = createKeyTranslator(mac);
      expect(t(key({ key: "Enter", code: "Enter", shiftKey: true }))).toBe("\n");
      // Its keypress must not reach xterm too, or "\r" follows the "\n".
      expect(t(key({ type: "keypress", key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
      expect(t(key({ key: "Enter", code: "Enter" }))).toBeNull();
    }
  });

  it("left Option is Meta on a Mac; right Option still composes", () => {
    const t = createKeyTranslator(true);
    t(key({ key: "Alt", code: "AltLeft", altKey: true }));
    expect(t(key({ key: "π", code: "KeyP", altKey: true }))).toBe("\x1bp");
    expect(t(key({ key: "ı", code: "KeyB", altKey: true, shiftKey: true }))).toBe("\x1bB");
    expect(t(key({ key: "≥", code: "Period", altKey: true }))).toBe("\x1b.");
    t(key({ type: "keyup", key: "Alt", code: "AltLeft" }));

    t(key({ key: "Alt", code: "AltRight", altKey: true }));
    expect(t(key({ key: "€", code: "Digit2", altKey: true, shiftKey: true }))).toBeNull();
    expect(t(key({ key: "´", code: "KeyE", altKey: true }))).toBeNull();
  });

  it("Cmd+←/→/⌫ edit the line on a Mac", () => {
    const t = createKeyTranslator(true);
    expect(t(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }))).toBe("\x01");
    expect(t(key({ key: "ArrowRight", code: "ArrowRight", metaKey: true }))).toBe("\x05");
    expect(t(key({ key: "Backspace", code: "Backspace", metaKey: true }))).toBe("\x15");
    // Copy, paste and the app's own ⌘ shortcuts are not the line editor's.
    expect(t(key({ key: "c", code: "KeyC", metaKey: true }))).toBeNull();
  });

  it("leaves Alt alone off a Mac", () => {
    const t = createKeyTranslator(false);
    t(key({ key: "Alt", code: "AltLeft", altKey: true }));
    expect(t(key({ key: "b", code: "KeyB", altKey: true }))).toBeNull();
  });
});
