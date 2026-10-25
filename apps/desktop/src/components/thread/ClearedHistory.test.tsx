import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { ClearedHistory } from "./ClearedHistory";

const thread = (text: string) => ({ blocks: [{ kind: "user" as const, text }], index: {}, loaded: true });

describe("cleared history", () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      sessions: [{ id: "ses_b", title: "B", directory: "/ws" }],
      threads: { ses_a: thread("first question"), ses_b: thread("second question") },
      clearedFrom: { ses_b: "ses_a" },
    });
  });

  it("keeps the nearest cleared conversation above a divider that says the model cannot see it", async () => {
    const onOpen = vi.fn();
    render(<ClearedHistory from="ses_b" connected handlers={{}} onOpen={onOpen} />);

    expect(screen.getByText("second question")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Context cleared" })).toBeInTheDocument();
    expect(screen.getByText(/no longer sees the messages above/)).toBeInTheDocument();
    // Read-only: no edit/revert controls on a session this pane no longer drives.
    expect(screen.queryByRole("button", { name: /edit|revert/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open that session" }));
    expect(onOpen).toHaveBeenCalledWith("ses_b");
  });

  it("chains repeated clears, older parts behind one row", async () => {
    render(<ClearedHistory from="ses_b" connected handlers={{}} onOpen={() => {}} />);
    expect(screen.queryByText("first question")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    const first = screen.getByText("first question");
    const second = screen.getByText("second question");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    // Only the nearest divider explains; ses_a no longer exists, so no way back to it.
    expect(screen.getAllByText(/no longer sees/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open that session" })).toHaveLength(1);
  });

  it("survives a cyclic record", () => {
    useRuntimeStore.setState({ clearedFrom: { ses_b: "ses_a", ses_a: "ses_b" } });
    render(<ClearedHistory from="ses_b" connected handlers={{}} onOpen={() => {}} />);
    expect(screen.getByText("second question")).toBeInTheDocument();
  });
});
