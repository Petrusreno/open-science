import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";

vi.mock("@/lib/tauri", () => ({ isTauri: true }));
vi.mock("./terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "terminal_event_names" ? ["data", "exit"] : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

// The one xterm instance, and the key handler it was given when created.
const xterm = vi.hoisted(() => ({ keyHandler: null as ((e: KeyboardEvent) => boolean) | null }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    loadAddon() {}
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      xterm.keyHandler = fn;
    }
    open() {}
    focus() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
const addon = class {
  fit() {}
  dispose() {}
  onContextLoss() {}
  onDidChangeResults() {
    return { dispose() {} };
  }
  findNext() {
    return false;
  }
  clearDecorations() {}
};
vi.mock("@xterm/addon-fit", () => ({ FitAddon: addon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: addon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: addon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: addon }));

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

describe("TerminalPane find", () => {
  it("opens on ⌘F and closes on Escape after the pane was remounted (as maximizing does)", async () => {
    const first = render(<TerminalPane leafId="t1" />);
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    first.unmount();
    // The terminal is parked and adopted by the next component; its key
    // handler is still the one bound at creation.
    render(<TerminalPane leafId="t1" />);

    const find = key({ key: "f", metaKey: true });
    act(() => void xterm.keyHandler!(find));
    expect(await screen.findByRole("textbox", { name: "Find" })).toBeInTheDocument();
    expect(find.defaultPrevented).toBe(true);

    // Escape from the terminal itself closes the bar, and is claimed so macOS
    // does not read it as "leave full screen".
    const esc = key({ key: "Escape" });
    let passedToShell = true;
    act(() => void (passedToShell = xterm.keyHandler!(esc)));
    expect(passedToShell).toBe(false);
    expect(esc.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).not.toBeInTheDocument());

    // With the bar shut, Escape belongs to the shell again.
    expect(xterm.keyHandler!(key({ key: "Escape" }))).toBe(true);
  });
});
