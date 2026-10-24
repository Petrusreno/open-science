import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { insertLeaf, makeContentLeaf, makeLeaf } from "@/lib/layout";
import { PaneSwitcher } from "./PaneSwitcher";

describe("PaneSwitcher (phone)", () => {
  it("shows nothing for a Screen of one pane", () => {
    const only = makeLeaf("session-a");
    const { container } = render(<PaneSwitcher tree={only} focusedLeafId={only.id} onFocus={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names every pane, marks the one on display, and a tap picks another", async () => {
    const conversation = makeLeaf("session-a");
    const shell = makeContentLeaf({ kind: "terminal", name: "build" });
    const tree = insertLeaf(conversation, conversation.id, "right", shell);
    const onFocus = vi.fn();
    render(<PaneSwitcher tree={tree} focusedLeafId={conversation.id} onFocus={onFocus} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveTextContent("build");

    await userEvent.click(tabs[1]);
    expect(onFocus).toHaveBeenCalledWith(shell.id);
  });
});
