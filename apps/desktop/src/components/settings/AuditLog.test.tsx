import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import type { AuditEntry, AuditFilter } from "@/lib/tauri";
import { AuditLog } from "./AuditLog";

const queryAudit = vi.hoisted(() => vi.fn(async (_f: AuditFilter): Promise<AuditEntry[]> => []));
vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  queryAudit,
  listWebAccounts: async () => ["lab1"],
}));

const log: AuditEntry[] = [
  { time: "2026-10-24T17:06:51Z", actor: "admin", via: "ses_b", action: "session.prompt", target: "ses_a", detail: "what did you tell lab1?", status: 204 },
  { time: "2026-10-24T17:06:41Z", actor: "account:lab1", action: "session.prompt", target: "ses_a", detail: "Hi from lab1", status: 204 },
  { time: "2026-10-24T17:06:40Z", actor: "account:lab1", action: "login.failed", target: "lab1", status: 401 },
];

beforeEach(() => {
  queryAudit.mockReset();
  queryAudit.mockImplementation(async (f) => (f.actor === "lab1" ? log.slice(1) : log));
  useRuntimeStore.setState({
    sessions: [
      { id: "ses_a", title: "Lab notes", directory: "/w" },
      { id: "ses_b", title: "Coordinator", directory: "/w" },
    ] as never,
  });
});

describe("Settings → Remote access → Audit log", () => {
  it("lists who did what, by name, with the agent and the words; filters by account", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);
    await screen.findByText("Hi from lab1");
    expect(screen.getAllByText("sent a message to")).toHaveLength(2);
    expect(screen.getAllByText("Lab notes")).toHaveLength(2);
    expect(screen.getByText("via the agent in Coordinator")).toBeInTheDocument();
    expect(screen.getByText("You (token)", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("failed to sign in")).toBeInTheDocument();
    expect(screen.getByText("failed (401)")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox"), "lab1");
    await waitFor(() => expect(queryAudit).toHaveBeenLastCalledWith({ actor: "lab1", limit: 50 }));
    await waitFor(() => expect(screen.queryByText("what did you tell lab1?")).not.toBeInTheDocument());
  });
});
