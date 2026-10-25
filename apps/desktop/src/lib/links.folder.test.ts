import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "./artifactFile";
import { resolveLink } from "./links";

// A conversation's folder under the base folder, as the desktop sees it.
const tree: Record<string, DirEntry[]> = {
  "sessions/s2": [],
  "sessions/s1": [{ path: "sessions/s1/research", name: "research", isDir: true, size: 0, modified: 0 }],
  "sessions/s1/research": [
    { path: "sessions/s1/research/report.md", name: "report.md", isDir: false, size: 1, modified: 0 },
    { path: "sessions/s1/research/data", name: "data", isDir: true, size: 0, modified: 0 },
  ],
};
const listDir = vi.hoisted(() => vi.fn(async (rel: string, _root?: string) => tree[rel] ?? []));
vi.mock("./artifactFile", async (orig) => ({ ...(await orig<object>()), listDir, resolveArtifactPath: async () => null }));
vi.mock("./tauri", async (orig) => ({ ...(await orig<object>()), workspaceBase: async () => "/Users/me/OS" }));


beforeEach(() => listDir.mockClear());

describe("a path in an answer, looked up in its conversation's folder", () => {
  it("finds a file and a folder, named base-relative as the Files tree does", async () => {
    expect(await resolveLink("research/report.md", "workspace", "/Users/me/OS/sessions/s1")).toEqual({
      kind: "path", path: "sessions/s1/research/report.md", root: "base", isDir: false, display: "research/report.md",
    });
    expect(await resolveLink("research/data/", "workspace", "/Users/me/OS/sessions/s1")).toMatchObject({
      path: "sessions/s1/research/data", isDir: true,
    });
    expect(listDir).toHaveBeenCalledWith("sessions/s1/research", "base");
  });

  it("is not a link when there is nothing there, it climbs out, or the folder is outside the base", async () => {
    expect(await resolveLink("research/missing.md", "workspace", "/Users/me/OS/sessions/s1")).toBeNull();
    expect(await resolveLink("../s2/secret.md", "workspace", "/Users/me/OS/sessions/s1")).toBeNull();
    expect(await resolveLink("research/report.md", "workspace", "/elsewhere/s1")).toBeNull();
  });

  it("an answer about another conversation finds that conversation's files", async () => {
    // Asked in s2, about s1: not in s2's folder, found in s1's.
    expect(
      await resolveLink("research/data/", "workspace", ["/Users/me/OS/sessions/s2", "/Users/me/OS/sessions/s1"]),
    ).toMatchObject({ path: "sessions/s1/research/data", isDir: true });
  });
});
