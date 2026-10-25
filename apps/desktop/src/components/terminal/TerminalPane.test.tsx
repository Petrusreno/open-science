import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TerminalPane } from "./TerminalPane";

vi.mock("@/lib/tauri", () => ({ isTauri: true, isMacUA: () => true }));
vi.mock("./terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "terminal_event_names" ? ["data", "exit"] : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

// The one xterm instance, and the key handler it was given when created.
// `cols` is what the fit addon last measured; a test changes it to resize.
const xterm = vi.hoisted(() => ({ keyHandler: null as ((e: KeyboardEvent) => boolean) | null, cols: 80 }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    get cols() {
      return xterm.cols;
    }
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

  it("leaves Ctrl+F to the shell on a Mac — it is the line editor's forward-char", async () => {
    render(<TerminalPane leafId="t2" />);
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    expect(xterm.keyHandler!(key({ key: "f", ctrlKey: true }))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Find" })).not.toBeInTheDocument();
  });
});

describe("TerminalPane resize", () => {
  it("tells the shell only the size the pane settles on, not every frame of an animation", async () => {
    let onResize: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          onResize = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const box = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    const boxH = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

    render(<TerminalPane leafId="t-resize" />);
    await waitFor(() => expect(onResize).not.toBeNull());
    vi.mocked(invoke).mockClear();

    // A sidebar animation: the grid loses a column per frame.
    for (let cols = 79; cols >= 70; cols--) {
      xterm.cols = cols;
      onResize!();
      await frame();
      await frame();
    }
    expect(invoke).not.toHaveBeenCalledWith("terminal_resize", expect.anything());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal_resize", { id: "t-resize", cols: 70, rows: 24 }),
    );
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "terminal_resize")).toHaveLength(1);

    box.mockRestore();
    boxH.mockRestore();
    vi.unstubAllGlobals();
    xterm.cols = 80;
  });
});
