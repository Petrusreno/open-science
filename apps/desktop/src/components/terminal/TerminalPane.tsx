import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { copyText } from "@/lib/clipboard";
import { useRuntimeStore } from "@/lib/runtime";
import { terminalTransport, terminalsAvailable } from "@/lib/terminalTransport";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "@/components/ui/ContextMenu";
import {
  getTerminal,
  markTerminalUsed,
  putTerminal,
} from "@/lib/terminalSessions";
import {
  findLeaf,
  resumeCommand,
  terminalStartup,
  useLayoutStore,
  type TerminalAgent,
} from "@/lib/layout";
import { registerTerminalLinks } from "./terminalLinks";
import { TerminalSearch } from "./TerminalSearch";
import { isJumpChord } from "@/components/jump-palette/JumpPalette";

/**
 * A real shell in a pane.
 *
 * xterm.js renders it; the PTY lives in Rust (`src-tauri/src/terminal.rs`).
 *
 * The terminal itself is NOT owned by this component — it lives in
 * `lib/terminalSessions`, keyed by the pane's leaf id, and this component only
 * re-parents it into place. Splitting a pane moves its leaf DEEPER in the tree
 * (the leaf becomes a child of a new split node), and React unmounts anything
 * that changes position, keys or not; a terminal whose lifetime followed its
 * component lost the user's shell every time they split the pane beside it.
 *
 * xterm and its CSS load on demand: a session that never opens a terminal
 * should not pay for one, the same rule the code editor follows.
 */
export function TerminalPane({
  leafId,
  cwd,
  command,
  agent,
  onSplit,
  onRename,
  onClose,
}: {
  leafId: string;
  cwd?: string;
  /** Typed into the shell once, when this terminal is first opened. */
  command?: string;
  /** The coding agent last seen in this terminal. Still running when the app
   *  last looked → its session is resumed on first open, INSTEAD of `command`
   *  (a relaunch picks the conversation back up rather than starting over).
   *  Exited → offered from the menu. */
  agent?: TerminalAgent;
  /** Right-click → Split. `kind` is what the NEW pane holds: another terminal,
   *  or a conversation about what this one just printed. */
  onSplit?: (dir: "row" | "col", kind: "terminal" | "session") => void;
  /** Right-click → Rename. The header owns the editor; this only opens it. */
  onRename?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("session");
  const host = useRef<HTMLDivElement | null>(null);
  const available = terminalsAvailable(useRuntimeStore((s) => s.webTerminal));
  const [searching, setSearching] = useState(false);
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  // The xterm key handler is bound once, when the terminal is created, but the
  // terminal outlives this component (it is re-parented on every split or
  // maximize). It reaches the search bar through this entry, which whichever
  // component currently shows the terminal keeps pointed at itself.
  useEffect(() => {
    const controls: FindControls = {
      open: () => setSearching(true),
      close: () => {
        setSearching(false);
        getTerminal(leafId)?.term.focus();
      },
      isOpen: () => searchingRef.current,
    };
    findControls.set(leafId, controls);
    return () => {
      if (findControls.get(leafId) === controls) findControls.delete(leafId);
    };
  }, [leafId]);

  useEffect(() => {
    if (!available || !host.current) return;
    const parent = host.current;
    let disposed = false;

    // Already running: adopt it. Everything — scrollback, the running program,
    // what the user had half-typed — is still there.
    const existing = getTerminal(leafId);
    if (existing) {
      parent.appendChild(existing.container);
      existing.fit.fit();
      existing.term.focus();
      return () => {
        // Park it, do not destroy it. Destruction belongs to the layout, which
        // alone knows the difference between "moved" and "closed".
        existing.container.remove();
      };
    }

    void (async () => {
      const [
        { Terminal },
        { FitAddon },
        { SearchAddon },
        { Unicode11Addon },
        { WebglAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;

      const container = document.createElement("div");
      container.className = "h-full w-full";
      parent.appendChild(container);

      const term = new Terminal({
        ...TERMINAL_OPTIONS,
        // Follows the app's palette rather than xterm's own black, so a
        // terminal in a light workspace is not a hole in the page.
        theme: readTheme(),
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      // xterm's default width table is Unicode 6, where emoji and many symbols
      // are one cell; Claude Code and Codex lay out with current Unicode, where
      // they are two. Every such glyph would shift the rest of its line by one.
      // Set before the first write: widths are fixed as text enters the buffer.
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      // ⌘F / Ctrl+F belongs to the app, not to the shell: xterm would otherwise
      // pass it through and some full-screen program would act on it.
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          findControls.get(leafId)?.open();
          return false;
        }
        // Escape with the bar open closes the bar, even with the caret back in
        // the terminal. Marked handled, or macOS takes an unclaimed Escape as
        // "leave full screen".
        if (
          event.type === "keydown" &&
          event.key === "Escape" &&
          findControls.get(leafId)?.isOpen()
        ) {
          event.preventDefault();
          findControls.get(leafId)?.close();
          return false;
        }
        // The jump palette's chord is the app's too: left to xterm, Ctrl+Shift+J
        // would reach the shell as a line feed.
        if (isJumpChord(event)) return false;
        return true;
      });
      term.open(container);
      // GPU renderer, as in VS Code and Orca: box-drawing and block characters
      // are drawn as exact cell-sized shapes instead of font glyphs, so rules
      // and borders join up as in a native terminal. Without WebGL, or once
      // the GPU drops the context, xterm falls back to its DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No WebGL here; the DOM renderer is already in place.
      }
      fit.fit();
      // Where the shell is NOW (the layout follows it, see `recordTerminal`),
      // so a relative path printed after a `cd` resolves where it should.
      const links = registerTerminalLinks(term, () => {
        for (const g of useLayoutStore.getState().groups) {
          const content = g.tree && findLeaf(g.tree, leafId)?.content;
          if (content?.kind === "terminal") return content.cwd ?? null;
        }
        return cwd ?? null;
      });

      const created = await terminalTransport.open(leafId, cwd, term.cols, term.rows);
      const unsubscribe = await terminalTransport.subscribe(leafId, {
        onData: (chunk) => term.write(chunk),
        onExit: () => term.write(`\r\n${t("terminal.exited")}\r\n`),
        onReset: () => term.reset(),
      });
      const input = term.onData((data) => {
        // The first keystroke is what makes this terminal worth asking about
        // before it is closed.
        markTerminalUsed(leafId);
        void terminalTransport.write(leafId, data);
      });

      // The pane is resizable and tiled; the shell has to be told, or every
      // full-screen program keeps drawing into the old box.
      //
      // Coalesced to one frame, and the shell is told only when the GRID
      // changed. Collapsing the sidebar animates a width for 200ms, which fires
      // this a dozen times per terminal; each call re-measures the DOM
      // synchronously and used to cross into Rust for a PTY ioctl, so a window
      // with a few terminals in it visibly stuttered for the whole animation.
      let queued = 0;
      let sent = { cols: term.cols, rows: term.rows };
      const observer = new ResizeObserver(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          // Parked, or on a Screen that is not on display: a zero box would
          // have xterm propose a nonsense grid.
          if (
            !container.isConnected ||
            !container.clientWidth ||
            !container.clientHeight
          )
            return;
          fit.fit();
          if (term.cols === sent.cols && term.rows === sent.rows) return;
          sent = { cols: term.cols, rows: term.rows };
          void terminalTransport.resize(leafId, term.cols, term.rows);
        });
      });
      observer.observe(container);

      // Sent once, on the pane's FIRST open — never on a remount, which would
      // re-run it over whatever the user is doing in that shell.
      // And only into a shell this open STARTED: one already running (the
      // desktop window and a web page share it) is in the middle of something.
      const startup = created ? terminalStartup({ command, agent }) : undefined;
      if (startup) {
        markTerminalUsed(leafId);
        void terminalTransport.write(leafId, `${startup}\n`);
      }

      putTerminal(leafId, {
        term,
        fit,
        search,
        container,
        dispose: () => {
          unsubscribe();
          input.dispose();
          links.dispose();
          observer.disconnect();
          if (queued) cancelAnimationFrame(queued);
        },
      });
      if (disposed) container.remove();
      else term.focus();
    })();

    return () => {
      disposed = true;
      getTerminal(leafId)?.container.remove();
    };
    // `cwd`, `command` and `agent` belong to the pane's first open. `cwd` and
    // `agent` are also rewritten every few seconds as the shell moves (see
    // `recordTerminal`), and none of that may rebuild a live terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, t, available]);

  /** Right-click, modelled on Orca's terminal menu (`TerminalContextMenu.tsx`):
   *  the clipboard actions first, because that is what a right-click in a
   *  terminal is usually for, then the pane's own layout actions. Without it
   *  the packaged app shows the WebView's page menu, whose "Open Link in New
   *  Window" means nothing over a shell. */
  const menuItems = (
    <>
      <ContextMenuItem
        onSelect={() => {
          const selection = getTerminal(leafId)?.term.getSelection() ?? "";
          if (selection) void copyText(selection);
        }}
      >
        {t("terminal.menu.copy")}
      </ContextMenuItem>
      {/* A browser reads the clipboard only on a secure origin; over a LAN
          http address it cannot, and ⌘V into the terminal still works. */}
      {canReadClipboard() && (
        <ContextMenuItem
          onSelect={() => {
            void readClipboard().then((text) => {
              if (!text) return;
              markTerminalUsed(leafId);
              void terminalTransport.write(leafId, text);
            });
          }}
        >
          {t("terminal.menu.paste")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => getTerminal(leafId)?.term.selectAll()}>
        {t("terminal.menu.selectAll")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          const terminal = getTerminal(leafId);
          terminal?.term.clear();
          terminal?.term.focus();
        }}
      >
        {t("terminal.menu.clear")}
      </ContextMenuItem>
      {cwd && isTauri && (
        <ContextMenuItem onSelect={() => void revealPath(cwd)}>
          {t("terminal.menu.revealCwd")}
        </ContextMenuItem>
      )}
      {/* Only once the agent has exited: typed while it runs, the command
          would land in the agent's own prompt. */}
      {agent && !agent.running && resumeCommand(agent) && (
        <ContextMenuItem
          onSelect={() => {
            markTerminalUsed(leafId);
            void terminalTransport.write(leafId, `${resumeCommand(agent)}\n`);
            getTerminal(leafId)?.term.focus();
          }}
        >
          {t("terminal.menu.resumeAgent", {
            agent: agent.kind === "claude" ? "Claude Code" : "Codex",
          })}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => setSearching(true)}>
        {t("terminal.search.find")}
      </ContextMenuItem>
      {onRename && (
        <ContextMenuItem onSelect={onRename}>
          {t("terminal.rename")}
        </ContextMenuItem>
      )}
      {(onSplit || onClose) && <ContextMenuSeparator />}
      {/* Split asks WHAT the new pane holds. A terminal beside a terminal is one
          common answer; a conversation about what this one just printed is the
          other, and it was previously unreachable without leaving the pane. */}
      {onSplit && (
        <>
          <ContextMenuSub label={t("group.splitRightShort")}>
            {/* eslint-disable i18next/no-literal-string -- split axis and pane kind, not UI copy */}
            <ContextMenuItem onSelect={() => onSplit("row", "terminal")}>
              {t("terminal.title")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplit("row", "session")}>
              {t("splitInto.session")}
            </ContextMenuItem>
          </ContextMenuSub>
          <ContextMenuSub label={t("group.splitDownShort")}>
            <ContextMenuItem onSelect={() => onSplit("col", "terminal")}>
              {t("terminal.title")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplit("col", "session")}>
              {t("splitInto.session")}
            </ContextMenuItem>
            {/* eslint-enable i18next/no-literal-string */}
          </ContextMenuSub>
        </>
      )}
      {onClose && (
        <ContextMenuItem onSelect={onClose}>
          {t("group.closePane")}
        </ContextMenuItem>
      )}
    </>
  );

  if (!available) {
    return (
      <div className="p-4 text-[13px] text-muted">
        {t(isGatewayWeb ? "terminal.webOff" : "terminal.desktopOnly")}
      </div>
    );
  }
  return (
    <ContextMenu items={menuItems} label={t("terminal.menu.label")}>
      {/* `relative`: the search bar floats over the terminal rather than
          pushing it, so the line being read does not move as you type. */}
      <div className="relative h-full w-full">
        <div ref={host} className="h-full w-full bg-surface p-2" />
        {searching && (
          <TerminalSearch
            addon={getTerminal(leafId)?.search ?? null}
            onClose={() => findControls.get(leafId)?.close()}
          />
        )}
      </div>
    </ContextMenu>
  );
}

interface FindControls {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** The find bar of whichever component currently shows each terminal. */
const findControls = new Map<string, FindControls>();

/**
 * Terminal defaults, borrowed from Orca's `lib/pane-manager/pane-terminal-options.ts`
 * (MIT) — a set of settings it arrived at the hard way, each for a reason worth
 * keeping. The ones that change behaviour rather than looks:
 *
 * - `macOptionClickForcesSelection`: while a program has grabbed the mouse
 *   (vim, htop, less), a plain drag goes to that program and selects nothing.
 *   Option+drag forces a selection anyway. Without it a terminal running
 *   anything full-screen simply cannot be selected from, which is what
 *   "can't select" looks like.
 * - `macOptionIsMeta: false`: non-US layouts compose `@` and `€` with Option;
 *   treating it as Meta makes those keys unreachable.
 * - `minimumContrastRatio`: this app's default surface is light, and plenty of
 *   CLIs print dark blue on the assumption of a dark one. xterm lifts such
 *   colours until they are legible instead of letting them vanish.
 * - `fontFamily`: a Nerd Font chain, so a powerline prompt renders as a prompt
 *   and not as a row of tofu.
 */
const TERMINAL_OPTIONS = {
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: "block",
  // xterm's default inactive outline turns a bar cursor into extra strokes in
  // a blurred pane; only a block cursor gains from the outline.
  cursorInactiveStyle: "outline",
  fontSize: 12.5,
  fontFamily:
    "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Cascadia Mono', 'Consolas', " +
    "'DejaVu Sans Mono', 'Symbols Nerd Font Mono', 'MesloLGS Nerd Font', monospace",
  fontWeight: "300",
  fontWeightBold: "500",
  // Enough to scroll back through a build log without holding a session's
  // worth of output in memory for every open pane.
  scrollback: 5000,
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  minimumContrastRatio: 4.5,
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  drawBoldTextInBrightColors: true,
} as const;

/** Clipboard reads and Finder, kept out of the menu body so it reads as a list
 *  of actions rather than a list of dynamic imports. */
function canReadClipboard(): boolean {
  return isTauri || typeof navigator.clipboard?.readText === "function";
}

async function readClipboard(): Promise<string> {
  if (!isTauri) return navigator.clipboard.readText();
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return (await readText()) ?? "";
}

async function revealPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_path", { path, root: null });
}

/** xterm paints its own canvas, so it cannot inherit CSS variables — the
 *  current values are read once and handed over. */
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--surface", "#ffffff"),
    foreground: value("--text", "#2a2723"),
    cursor: value("--accent", "#c15f3c"),
    selectionBackground: value("--surface-2", "#f2efe7"),
  };
}
