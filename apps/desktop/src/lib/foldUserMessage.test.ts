import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { foldUserMessage } from "./runtime";

const none = () => undefined;

describe("foldUserMessage", () => {
  it("tags our own echo by its words", () => {
    const blocks: ThreadBlock[] = [{ kind: "user", text: "fit   the\ncurve" }];
    expect(foldUserMessage(blocks, "m1", "fit the curve", { sendingHere: false, asTypedCommand: none })).toEqual([
      { kind: "user", text: "fit   the\ncurve", messageID: "m1" },
    ]);
  });

  it("a message already shown changes nothing, unless more of it arrives", () => {
    const blocks: ThreadBlock[] = [{ kind: "user", text: "hi", messageID: "m1" }];
    expect(foldUserMessage(blocks, "m1", "hi", { sendingHere: false, asTypedCommand: none })).toBeNull();
    expect(foldUserMessage(blocks, "m1", "hi there", { sendingHere: false, asTypedCommand: none })).toEqual([
      { kind: "user", text: "hi there", messageID: "m1" },
    ]);
    const command: ThreadBlock[] = [{ kind: "user", text: "/review", messageID: "m2" }];
    expect(foldUserMessage(command, "m2", "Review the work", { sendingHere: false, asTypedCommand: none })).toBeNull();
  });

  it("our echo in other words (a command) is still ours while we are sending", () => {
    const blocks: ThreadBlock[] = [{ kind: "user", text: "/review now" }];
    const out = foldUserMessage(blocks, "m1", "Review the work so far…", { sendingHere: true, asTypedCommand: none });
    expect(out).toEqual([{ kind: "user", text: "/review now", messageID: "m1" }]);
  });

  it("a command's expansion is shown as the command", () => {
    const out = foldUserMessage([], "m1", "TEMPLATE x", {
      sendingHere: false,
      asTypedCommand: (t) => (t.startsWith("TEMPLATE") ? "/do x" : undefined),
    });
    expect(out).toEqual([{ kind: "user", text: "/do x", messageID: "m1" }]);
  });

  it("a message from elsewhere is added, and never stamped onto a `!` shell echo", () => {
    const blocks: ThreadBlock[] = [{ kind: "user", text: "! ls" }];
    expect(foldUserMessage(blocks, "m9", "ask from agent B", { sendingHere: false, asTypedCommand: none })).toEqual([
      { kind: "user", text: "! ls" },
      { kind: "user", text: "ask from agent B", messageID: "m9" },
    ]);
  });
});
