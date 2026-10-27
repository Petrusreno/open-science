import { beforeEach, describe, expect, it } from "vitest";
import { leaves, useLayoutStore } from "./layout";

describe("replacing a pane", () => {
  beforeEach(() => {
    useLayoutStore.setState({ groups: [], activeGroupId: "", tree: null, focusedLeafId: null });
    useLayoutStore.getState().addGroup();
  });

  it("puts a terminal where a conversation was, in the same place, with a new id", () => {
    const left = useLayoutStore.getState().openContentPane({ kind: "files" });
    const conversation = useLayoutStore.getState().dockSession(left, "right", "ses_1");
    useLayoutStore.getState().replacePane(conversation, {
      content: { kind: "terminal", cwd: "/ws", agent: { kind: "claude", sessionId: "ses_1", running: true } },
    });
    const all = leaves(useLayoutStore.getState().tree!);
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(left);
    expect(all[1].id).not.toBe(conversation);
    expect(all[1].content).toMatchObject({ kind: "terminal", cwd: "/ws" });
    expect(useLayoutStore.getState().focusedLeafId).toBe(all[1].id);
  });
});
