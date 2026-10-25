import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { compactRefusal } from "./compactGate";

const usage = (input: number) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const user: ThreadBlock = { kind: "user", text: "q" };
const reply = (tokens: number): ThreadBlock => ({ kind: "agent", markdown: "a", usage: usage(tokens) });
const compaction: ThreadBlock = { kind: "compaction", auto: false };

describe("compactRefusal", () => {
  it("refuses with nothing to compact", () => {
    expect(compactRefusal(undefined)).toEqual({ kind: "empty" });
    expect(compactRefusal([])).toEqual({ kind: "empty" });
  });

  it("refuses under 100k and allows from there", () => {
    expect(compactRefusal([user, reply(42_000)], 200_000)).toEqual({ kind: "small", used: 42_000, threshold: 100_000 });
    expect(compactRefusal([user, reply(120_000)], 200_000)).toBeNull();
  });

  it("lowers the bar to half the window for a small model", () => {
    expect(compactRefusal([user, reply(40_000)], 64_000)).toBeNull();
  });

  it("refuses a second compaction until a new turn — the summary's own usage does not count", () => {
    expect(compactRefusal([user, reply(150_000), compaction, reply(150_000)], 200_000)).toEqual({
      kind: "justCompacted",
    });
    expect(compactRefusal([user, reply(150_000), compaction, reply(150_000), user, reply(12_000)], 200_000)).toEqual({
      kind: "small",
      used: 12_000,
      threshold: 100_000,
    });
  });

  it("does not refuse when usage is unknown", () => {
    expect(compactRefusal([user, { kind: "agent", markdown: "a" }])).toBeNull();
  });
});
