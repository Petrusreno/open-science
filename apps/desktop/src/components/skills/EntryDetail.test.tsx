import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryDetail, skillBody } from "./EntryDetail";

vi.mock("@/lib/tauri", () => ({ isTauri: true }));
vi.mock("@/lib/webMode", () => ({ isGatewayWeb: false }));
const readArtifact = vi.fn();
vi.mock("@/lib/artifactFile", () => ({
  readArtifact: (...args: unknown[]) => readArtifact(...args),
  revealArtifact: vi.fn(),
}));

describe("skillBody", () => {
  it("drops the frontmatter the header already shows", () => {
    expect(skillBody("---\nname: x\ndescription: y\n---\n\n# Steps\nDo it.\n")).toBe("# Steps\nDo it.");
    expect(skillBody("﻿---\r\nname: x\r\n---\r\nBody")).toBe("Body");
    expect(skillBody("No frontmatter")).toBe("No frontmatter");
  });
});

describe("EntryDetail", () => {
  it("shows a skill's SKILL.md and where it lives", async () => {
    readArtifact.mockResolvedValueOnce({
      encoding: "utf8",
      data: "---\nname: r-stats\n---\nRun the test in R.",
    });
    render(
      <EntryDetail
        entry={{
          kind: "skill",
          name: "r-stats",
          description: "Statistics in R",
          location: "/home/u/s/SKILL.md",
        }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Run the test in R.")).toBeInTheDocument();
    expect(readArtifact).toHaveBeenCalledWith("/home/u/s/SKILL.md", "home");
    expect(screen.getByText("/home/u/s/SKILL.md")).toBeInTheDocument();
  });

  it("shows only the description when there is no file to read", () => {
    render(
      <EntryDetail
        entry={{ kind: "skill", name: "builtin", description: "Built in", location: "<built-in>" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Built in")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in folder" })).not.toBeInTheDocument();
  });
});
