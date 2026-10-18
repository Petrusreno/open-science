import { beforeEach, describe, expect, it, vi } from "vitest";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;
Object.defineProperty(window, "location", {
  value: { ...window.location, origin: "http://gw" },
  writable: true,
});

const fetchMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => {
    throw new Error("the web client must not use Tauri IPC");
  },
}));

const { recordRun } = await import("./runs");

describe("run recording in the web client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("os_gateway_token", "synthetic-token");
  });

  it("posts a completed execution with its session and window to the gateway", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ runId: "run_1" }) });

    await recordRun({
      command: "python3 analysis.py",
      log: "A 11\nB 21\n",
      startedAt: 1_000,
      endedAt: 1_500,
      status: "ok",
      surface: "local",
    }, "ses_1", null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/runs");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer synthetic-token");
    expect(JSON.parse(init.body)).toEqual({
      command: "python3 analysis.py",
      log: "A 11\nB 21\n",
      startedAt: 1_000,
      endedAt: 1_500,
      status: "ok",
      surface: "local",
      sessionId: "ses_1",
      model: null,
    });
  });

  it("does not submit an unbound run", async () => {
    await recordRun({ command: "python3 analysis.py", status: "ok", surface: "local" }, undefined, null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
