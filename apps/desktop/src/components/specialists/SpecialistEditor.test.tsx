import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ProviderInfo, SkillInfo } from "@ai4s/sdk";
import type { Specialist } from "@/lib/specialists";
import { SpecialistEditor } from "./SpecialistEditor";

vi.mock("@/lib/tauri", () => ({ isTauri: true }));

const skills: SkillInfo[] = [
  { name: "r-stats", description: "Statistics in R" },
  { name: "python-stats", description: "Statistics in Python" },
];
const connectors: McpServer[] = [
  { name: "pubmed", status: "connected" },
  { name: "pubmed_central", status: "connected" },
  { name: "arxiv", status: "disabled" },
];
const providers = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
] as unknown as ProviderInfo[];
const onSave = vi.fn(async (_s: Specialist, _create: boolean) => {});
const onDelete = vi.fn(async (_id: string) => {});
const onClose = vi.fn();

function open(initial: Specialist | null = null) {
  return render(
    <MemoryRouter>
      <SpecialistEditor
        initial={initial}
        takenIds={["build", "reviewer"]}
        skills={skills}
        connectors={connectors}
        providers={providers}
        onSave={onSave}
        onDelete={onDelete}
        onClose={onClose}
      />
    </MemoryRouter>,
  );
}

const existing: Specialist = {
  id: "stats-reviewer",
  description: "Reviews statistics",
  color: "#2563EB",
  instructions: "Be strict.",
  skills: ["r-stats"],
  blockedConnectors: ["arxiv"],
  model: "",
};

beforeEach(() => {
  onSave.mockClear();
  onDelete.mockClear();
  onClose.mockClear();
});

describe("SpecialistEditor", () => {
  it("creates a specialist from a name and a description, everything else open", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "Stats Reviewer");
    expect(screen.getByText("Saved as stats-reviewer")).toBeInTheDocument();
    await user.type(screen.getByLabelText("When to use"), "Reviews statistics");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).toHaveBeenCalledWith(
      {
        id: "stats-reviewer",
        description: "Reviews statistics",
        color: null,
        instructions: "",
        skills: null,
        blockedConnectors: [],
        model: "",
      },
      true,
    );
  });

  it("takes a name in any script as its id", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "论文写作");
    expect(screen.getByText("Saved as 论文写作")).toBeInTheDocument();
    await user.type(screen.getByLabelText("When to use"), "Writes papers");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "论文写作" }), true);
  });

  it("picks its model in place, without leaving the draft", async () => {
    const user = userEvent.setup();
    open(existing);
    const picker = screen.getByLabelText("Model");
    expect(picker).toHaveValue("");
    await user.selectOptions(picker, "openai/gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ ...existing, model: "openai/gpt-5-mini" }, false);
  });

  it("keeps a pinned model the catalog no longer lists", () => {
    open({ ...existing, model: "gone/old-model" });
    expect(screen.getByLabelText("Model")).toHaveValue("gone/old-model");
    expect(screen.getByRole("option", { name: "gone/old-model (not in the catalog)" })).toBeInTheDocument();
  });

  it("says a name is taken or unusable as it is typed, and refuses to save", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "Reviewer");
    expect(screen.getByText("An agent called reviewer already exists.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "！？");
    expect(screen.getByText(/at least one letter or digit/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("When to use"), "x");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("asks for a description before creating", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "a");
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(screen.getByText("Describe when it should be used.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("limits skills and connectors", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "a");
    await user.type(screen.getByLabelText("When to use"), "Does a");
    await user.click(screen.getByRole("radio", { name: "Only selected" }));
    expect(screen.getByText("None selected: this specialist uses no skills.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /python-stats/ }));
    await user.click(screen.getByRole("switch", { name: "arxiv" }));
    await user.click(screen.getByRole("radio", { name: "Violet" }));
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ skills: ["python-stats"], blockedConnectors: ["arxiv"], color: "#7C3AED" }),
      true,
    );
  });

  it("refuses a connector block that would also catch another connector", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Name"), "a");
    await user.type(screen.getByLabelText("When to use"), "Does a");
    await user.click(screen.getByRole("switch", { name: "pubmed" }));
    expect(screen.getByText(/would also turn off pubmed_central/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).not.toHaveBeenCalled();
    // Turning both off is what the rule actually does — that saves.
    await user.click(screen.getByRole("switch", { name: "pubmed_central" }));
    await user.click(screen.getByRole("button", { name: "Create specialist" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ blockedConnectors: ["pubmed", "pubmed_central"] }),
      true,
    );
  });

  it("edits in place: id fixed, save only once something changed", async () => {
    const user = userEvent.setup();
    open(existing);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Instructions"), " Cite sources.");
    await user.click(save);
    expect(onSave).toHaveBeenCalledWith({ ...existing, instructions: "Be strict. Cite sources." }, false);
  });

  it("confirms before deleting and before discarding edits", async () => {
    const user = userEvent.setup();
    open(existing);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Delete" }).slice(-1)[0]);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("stats-reviewer"));
  });

  it("asks before throwing away unsaved changes", async () => {
    const user = userEvent.setup();
    open(existing);
    await user.type(screen.getByLabelText("When to use"), " more");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows why a save failed and stays open", async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValueOnce(new Error("disk full"));
    open(existing);
    await user.type(screen.getByLabelText("When to use"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(onClose).not.toHaveBeenCalled();
  });
});
