import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import type { AuditEntry, AuditFilter } from "@/lib/tauri";
import { TerminalSenders } from "./TerminalSenders";

const queryAudit = vi.hoisted(() => vi.fn(async (_f: AuditFilter): Promise<AuditEntry[]> => []));
vi.mock("@/lib/tauri", () => ({ isTauri: true, queryAudit }));
const copyReference = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/agentReference", async (orig) => ({ ...(await orig<object>()), copyReference }));

const input = (time: string, actor: string, detail: string, via?: string): AuditEntry => ({
  time, actor, action: "terminal.input", target: "p7", detail, status: 200, ...(via ? { via } : {}),
});

beforeEach(() => {
  queryAudit.mockReset();
  copyReference.mockClear();
  useRuntimeStore.setState({ sessions: [{ id: "ses_b", title: "Coordinator B", directory: "/w/b" }] as never });
});

describe("terminal header: who typed into it from outside", () => {
  it("shows nothing when only the owner typed", async () => {
    queryAudit.mockResolvedValue([input("2026-10-24T18:00:00Z", "admin", "ls⏎")]);
    const { container } = render(<TerminalSenders leafId="p7" />);
    await vi.waitFor(() => expect(queryAudit).toHaveBeenCalledWith({ target: "p7", action: "terminal.input", limit: 20 }));
    expect(container).toBeEmptyDOMElement();
  });

  it("names the last outside sender, lists recent lines on hover, copies the agent's reference on click", async () => {
    queryAudit.mockResolvedValue([
      input("2026-10-24T18:02:00Z", "admin", "what failed?⏎", "ses_b"),
      input("2026-10-24T18:01:00Z", "admin", "ls⏎"),
      input("2026-10-24T18:00:00Z", "account:lab1", "make test⏎"),
    ]);
    render(<TerminalSenders leafId="p7" />);
    const badge = await screen.findByRole("button", { name: /Coordinator B/ });
    await userEvent.hover(badge);
    expect((await screen.findAllByText("Recent input from outside:")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("what failed?⏎").length).toBeGreaterThan(0);
    expect(screen.getAllByText("make test⏎").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("ls⏎")).toHaveLength(0);
    await userEvent.click(badge);
    expect(copyReference).toHaveBeenCalledWith(expect.stringContaining("[OSD session] Coordinator B · ses_b · /w/b"), expect.any(String));
  });
});
