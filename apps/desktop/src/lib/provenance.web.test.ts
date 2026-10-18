import { beforeEach, describe, expect, it, vi } from "vitest";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;
Object.defineProperty(window, "location", {
  value: { ...window.location, origin: "http://gw" },
  writable: true,
});

const fetchMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => { throw new Error("browser must not use Tauri IPC"); },
}));

const { listProvenance, readEnvLockfile } = await import("./provenance");

describe("provenance in the gateway web client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("os_gateway_token", "tok");
  });

  it("reads one artifact's history through the authenticated gateway", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [{ path: "fig/plot.svg", runId: "run_1" }],
    });
    expect(await listProvenance("fig/plot.svg")).toEqual([{ path: "fig/plot.svg", runId: "run_1" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/provenance?path=fig%2Fplot.svg");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("reads a captured environment lockfile as text", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "numpy==2.0\n",
    });
    expect(await readEnvLockfile("ab12")).toBe("numpy==2.0\n");
    expect(fetchMock.mock.calls[0][0]).toBe("http://gw/v1/provenance/lockfile?hash=ab12");
  });
});
