import { describe, expect, it } from "vitest";
import { rollCall } from "./tabRollCall";

describe("counting this browser's tabs", () => {
  it("counts the tabs already open, and then answers the next one", async () => {
    // Each call stands for a tab opening after the ones before it.
    expect(await rollCall(50)).toBe(1);
    expect(await rollCall(50)).toBe(2);
    expect(await rollCall(50)).toBe(3);
  });
});
