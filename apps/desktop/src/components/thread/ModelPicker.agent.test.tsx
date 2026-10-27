// The model picker leads with the agent: a new conversation picks it in the
// same popover as its model; an existing one names it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { ModelPicker, type AgentControl } from "./ModelPicker";

vi.mock("@/lib/cliAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cliAgents")>()),
  detectCliAgentsOnce: async () => [],
}));

const MODEL = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet", description: "Faster" },
  ],
};

function control(over: Partial<AgentControl> = {}): AgentControl {
  return { value: null, locked: false, onChange: vi.fn(), options: [], onOption: vi.fn(), ...over };
}

const renderPicker = (agent: AgentControl) =>
  render(
    <MemoryRouter>
      <ModelPicker sessionId="draft:leaf" agent={agent} />
    </MemoryRouter>,
  );

describe("ModelPicker with an agent", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "cli-claude-code", name: "Claude Code", command: "npx", args: [] }]),
    );
    useRuntimeStore.setState({ providers: [], defaultModel: null });
  });

  it("offers the agents in a new conversation and switches on a pick", async () => {
    const user = userEvent.setup();
    const agent = control();
    renderPicker(agent);
    await user.click(screen.getByRole("button", { name: /switch model/i }));

    expect(screen.getByRole("tab", { name: "OpenCode" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(agent.onChange).toHaveBeenCalledWith("cli-claude-code");
  });

  it("names the agent and its model on the chip, and lists the agent's own models", async () => {
    const user = userEvent.setup();
    const agent = control({ value: "cli-claude-code", options: [MODEL] });
    renderPicker(agent);
    const chip = screen.getByRole("button", { name: /switch model/i });
    expect(chip).toHaveTextContent("Claude Code · Opus");

    await user.click(chip);
    await user.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(agent.onOption).toHaveBeenCalledWith("model", "sonnet");
  });

  it("says when the agent will list its models, before it ever has", async () => {
    const user = userEvent.setup();
    renderPicker(control({ value: "cli-claude-code" }));
    await user.click(screen.getByRole("button", { name: /switch model/i }));
    expect(screen.getByText(/Claude Code lists its models once it has started/)).toBeInTheDocument();
  });

  it("keeps an existing conversation on its agent", async () => {
    const user = userEvent.setup();
    renderPicker(control({ value: "cli-claude-code", locked: true, options: [MODEL] }));
    await user.click(screen.getByRole("button", { name: /switch model/i }));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("New conversation to use another agent")).toBeInTheDocument();
  });
});
