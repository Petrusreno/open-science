import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutGroup } from "./layout";

vi.mock("./tauri", () => ({ isTauri: false, publishDesktopLayout: vi.fn() }));
const who = vi.hoisted(() => ({ account: null as string | null, source: "desktop" as "desktop" | "own" }));
vi.mock("./webMode", () => ({
  isGatewayWeb: true,
  gatewayOrigin: () => "http://gw",
  gatewayToken: () => "s".repeat(64),
  signedInAccount: () => who.account,
  layoutSource: () => who.source,
  setLayoutSource: (s: "desktop" | "own") => {
    who.source = s;
  },
}));

const { useLayoutStore, leaves } = await import("./layout");
const { adoptAccountLayout, layoutChanged, mirrorDesktopLayout, resetLayoutSync, switchLayoutSource } =
  await import("./layoutSync");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** The desktop's Screens as it would publish them: a conversation beside a
 *  terminal running an agent, and an untouched draft. */
const desktop: LayoutGroup[] = [
  {
    id: "g1",
    name: "Analysis",
    projectId: "proj-a",
    focusedLeafId: "p2",
    zoomedLeafId: null,
    tree: {
      kind: "split",
      id: "p1",
      dir: "row",
      sizes: [0.6, 0.4],
      children: [
        { kind: "leaf", id: "p2", sessionId: "ses_1" },
        {
          kind: "leaf",
          id: "p3",
          sessionId: null,
          content: {
            kind: "terminal",
            cwd: "/work",
            name: "build",
            command: "make",
            agent: { kind: "claude", sessionId: "abc", running: true },
          },
        },
      ],
    },
  },
  { id: "g2", name: "", focusedLeafId: "p4", zoomedLeafId: null, tree: { kind: "leaf", id: "p4", sessionId: null } },
];

beforeEach(() => {
  resetLayoutSync();
  who.account = "dana";
  who.source = "desktop";
  window.localStorage.clear();
  useLayoutStore.getState().reset(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an account's Screens", () => {
  it("are adopted from the desktop when it has them", async () => {
    const fetchMock = vi.fn(async () => json({ groups: desktop.slice(0, 1), activeGroupId: "g1" }));
    vi.stubGlobal("fetch", fetchMock);
    await adoptAccountLayout();
    const s = useLayoutStore.getState();
    expect(s.groups.map((g) => g.name)).toEqual(["Analysis"]);
    expect(fetchMock).toHaveBeenCalledWith("http://gw/v1/me/layout", expect.anything());
  });

  it("start as this browser's on first sign-in, and are written back as they change", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ ok: true }) : json(null),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    // Before the account's layout is read nothing is written over it.
    layoutChanged('{"groups":[]}');
    await vi.runAllTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();

    await adoptAccountLayout();
    const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts()).toHaveLength(1); // this browser's layout became the account's

    layoutChanged('{"a":1}');
    layoutChanged('{"a":2}');
    await vi.runAllTimersAsync();
    expect(puts()).toHaveLength(2);
    expect(puts()[1][1]?.body).toBe('{"a":2}'); // one write for a burst of changes
  });
});

describe("the token's Screens are the desktop window's, live", () => {
  beforeEach(() => {
    who.account = null;
  });

  it("takes the window's layout, follows newer revisions, and writes its own changes back", async () => {
    let served = { rev: 10, layout: { groups: desktop.slice(0, 1), activeGroupId: "g1" } as unknown };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ rev: 12 });
      const since = new URL(url).searchParams.get("since");
      return since === String(served.rev) ? new Response(null, { status: 204 }) : json(served);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    await mirrorDesktopLayout();
    expect(useLayoutStore.getState().groups.map((g) => g.name)).toEqual(["Analysis"]);
    const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    // Adopting it is a local change too; it must not bounce back.
    await vi.advanceTimersByTimeAsync(500);
    expect(puts()).toHaveLength(0);

    // The window moved on: the next poll shows it.
    served = {
      rev: 11,
      layout: { groups: [{ ...desktop[0], name: "Renamed on the desktop" }], activeGroupId: "g1" },
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(useLayoutStore.getState().groups[0].name).toBe("Renamed on the desktop");

    // A change made here goes to the shared layout, not an account's.
    useLayoutStore.getState().renameGroup(useLayoutStore.getState().groups[0].id, "Renamed on the web");
    await vi.advanceTimersByTimeAsync(400);
    expect(puts()).toHaveLength(1);
    expect(puts()[0][0]).toBe("http://gw/v1/layout/desktop");
    expect(puts()[0][1]?.body).toContain("Renamed on the web");
  });

  it("gives a window that has published nothing this browser's Screens", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ rev: 1 }) : json({ rev: 0, layout: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mirrorDesktopLayout();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
    );
  });
});

describe("a token client's own Screens", () => {
  beforeEach(() => {
    who.account = null;
  });

  it("start as a copy of the window's, then leave the window alone; switching back follows it again", async () => {
    const served = { rev: 10, layout: { groups: desktop.slice(0, 1), activeGroupId: "g1" } };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ rev: 99 });
      return new URL(url).searchParams.get("since") === "10" ? new Response(null, { status: 204 }) : json(served);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    await mirrorDesktopLayout();
    expect(useLayoutStore.getState().groups[0].name).toBe("Analysis");

    await switchLayoutSource("own");
    const own = useLayoutStore.getState();
    expect(own.groups.map((g) => g.name)).toEqual(["Analysis"]);
    const [, term] = leaves(own.groups[0].tree!);
    expect(term.id).not.toBe("p3"); // its own pane, so its own shell
    expect(term.content).toEqual({ kind: "terminal", cwd: "/work", name: "build" });

    // Changes stay in this browser: nothing is written to the window.
    useLayoutStore.getState().renameGroup(own.groups[0].id, "Mine");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(window.localStorage.getItem("ai4s.layout.own")).toContain("Mine");

    // Back to the window's, and its Screens are shown again.
    await switchLayoutSource("desktop");
    expect(useLayoutStore.getState().groups[0].name).toBe("Analysis");
    // And back to its own: kept, not copied afresh.
    await switchLayoutSource("own");
    expect(useLayoutStore.getState().groups[0].name).toBe("Mine");
  });

  it("are what a reload shows when this browser chose them", async () => {
    window.localStorage.setItem(
      "ai4s.layout.own",
      JSON.stringify({ groups: [{ ...desktop[0], name: "Saved here" }], activeGroupId: "g1" }),
    );
    who.source = "own";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mirrorDesktopLayout();
    expect(useLayoutStore.getState().groups[0].name).toBe("Saved here");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
