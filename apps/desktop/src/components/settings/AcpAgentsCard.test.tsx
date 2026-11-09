import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAcpAgents, activeAcpAgentId } from "@/lib/acpAgents";
import { useRuntimeStore } from "@/lib/runtime";
import { AcpAgentsCard } from "./AcpAgentsCard";

// The card edits the agent list and the default for new conversations; a
// running agent is the store's, so stopping one is a spy here.
const stopAcpAgent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ isTauri: true }));
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  stopAcpAgent,
}));

beforeEach(() => {
  window.localStorage.clear();
  stopAcpAgent.mockClear();
  useRuntimeStore.setState({ defaultRuntime: null });
});

describe("Settings → the agents conversations run on", () => {
  it("adds a preset agent and makes it the default for new conversations", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsCard />);

    // Nothing configured yet: the bundled runtime is the default.
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    ]);
    // Adding an agent does not make it the default.
    expect(activeAcpAgentId()).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Codex" }));
    expect(activeAcpAgentId()).toBe("acp-1");
    // Choosing a default starts nothing: conversations start agents as they need them.
    expect(stopAcpAgent).not.toHaveBeenCalled();
  });

  it("falls back to the bundled runtime when the default agent is removed, and stops it", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Gemini CLI", command: "gemini", args: ["--acp"] }]),
    );
    useRuntimeStore.getState().setDefaultRuntime("acp-1");
    render(<AcpAgentsCard />);

    expect(screen.getByRole("radio", { name: "Gemini CLI" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(loadAcpAgents()).toEqual([]);
    expect(activeAcpAgentId()).toBeNull();
    expect(stopAcpAgent).toHaveBeenCalledWith("acp-1");
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("saves an edited command and stops the process started from the old one", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Codex", command: "codex", args: [] }]),
    );
    render(<AcpAgentsCard />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Arguments"), `--config "/Users/me/My Agents/acp.json"`);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Split the way a shell would, but never THROUGH a shell: a quoted path
    // with spaces survives.
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "Codex", command: "codex", args: ["--config", "/Users/me/My Agents/acp.json"] },
    ]);
    expect(stopAcpAgent).toHaveBeenCalledWith("acp-1");
  });
});
