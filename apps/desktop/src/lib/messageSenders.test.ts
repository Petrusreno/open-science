import { describe, expect, it } from "vitest";
import type { AuditEntry } from "./tauri";
import { sendersFrom } from "./messageSenders";

const entry = (actor: string, detail: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  time: "2026-10-24T17:06:41Z",
  actor,
  action: "session.prompt",
  target: "ses_a",
  detail,
  status: 204,
  ...extra,
});

describe("message senders", () => {
  it("credits accounts and agents, never the owner, matching the words", () => {
    const senders = sendersFrom(
      [
        // Newest first, as the log answers.
        entry("admin", "what did you tell lab1?", { via: "ses_b" }),
        entry("admin", "my own message"),
        entry("account:lab1", "Hi from   lab1\non the web."),
        entry("account:lab1", "elsewhere", { target: "ses_other" }),
      ],
      "ses_a",
      (id) => (id === "ses_b" ? "Coordinator" : undefined),
    );
    expect(senders.get("Hi from lab1 on the web.")).toEqual({ account: "lab1" });
    expect(senders.get("what did you tell lab1?")).toEqual({ account: null, viaId: "ses_b", viaSession: "Coordinator" });
    expect(senders.has("my own message")).toBe(false);
    expect(senders.has("elsewhere")).toBe(false);
  });

  it("a long message is matched by the start the log keeps", () => {
    const long = "x".repeat(600);
    const senders = sendersFrom([entry("account:lab1", `${"x".repeat(500)}… (600 characters)`)], "ses_a");
    expect(senders.get(long.slice(0, 200))).toEqual({ account: "lab1" });
  });
});
