// A terminal running Claude Code or Codex can continue as a conversation in the
// app, in the terminal's place.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { leaves, useLayoutStore, type PaneContent } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { loadAcpAgents } from "@/lib/acpAgents";
import { ContentPane } from "./ContentPane";

vi.mock("@/components/terminal/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="terminal" />,
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));

const adoptAcpSession = vi.fn(async () => {});

function openTerminal(content: PaneContent) {
  useLayoutStore.setState({ groups: [], activeGroupId: "", tree: null, focusedLeafId: null });
  useLayoutStore.getState().addGroup();
  const leafId = useLayoutStore.getState().openContentPane(content);
  render(<ContentPane content={content} leafId={leafId} onClose={() => {}} />);
  return leafId;
}

describe("continuing a terminal agent as a conversation", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    adoptAcpSession.mockClear();
    useRuntimeStore.setState({ adoptAcpSession });
  });

  it("adopts the session on its agent and puts the conversation where the terminal was", async () => {
    const user = userEvent.setup();
    const leafId = openTerminal({
      kind: "terminal",
      cwd: "/ws/project",
      agent: { kind: "claude", sessionId: "0b1c2d3e-aaaa", running: true },
    });

    await user.click(screen.getByRole("button", { name: "Open as conversation" }));
    // Nothing moves until the user confirms.
    expect(adoptAcpSession).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Claude Code");
    await user.click(within(dialog).getByRole("button", { name: "Open as conversation" }));

    await waitFor(() =>
      expect(adoptAcpSession).toHaveBeenCalledWith("cli-claude-code", "0b1c2d3e-aaaa", "/ws/project"),
    );
    // The agent got its entry, so the conversation reopens on it after a restart.
    expect(loadAcpAgents().map((a) => a.id)).toEqual(["cli-claude-code"]);
    const tree = useLayoutStore.getState().tree!;
    const all = leaves(tree);
    // The terminal is gone (its shell closes with it); the conversation is there.
    expect(all.some((l) => l.id === leafId)).toBe(false);
    expect(all.map((l) => l.sessionId)).toEqual(["0b1c2d3e-aaaa"]);
  });

  it("leaves the terminal alone when the user cancels", async () => {
    const user = userEvent.setup();
    const leafId = openTerminal({
      kind: "terminal",
      cwd: "/ws/project",
      agent: { kind: "codex", sessionId: "019a", running: true },
    });
    await user.click(screen.getByRole("button", { name: "Open as conversation" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(adoptAcpSession).not.toHaveBeenCalled();
    expect(leaves(useLayoutStore.getState().tree!).map((l) => l.id)).toEqual([leafId]);
  });

  it("offers nothing for a plain shell", () => {
    openTerminal({ kind: "terminal", cwd: "/ws/project" });
    expect(screen.queryByRole("button", { name: "Open as conversation" })).not.toBeInTheDocument();
  });
});
