import { describe, expect, it } from "vitest";
import { connectorCollisions, connectorPrefix, MAX_ID, specialistId } from "./specialists";

describe("specialistId", () => {
  it("turns a typed name into the id it is saved under", () => {
    expect(specialistId("Stats reviewer")).toBe("stats-reviewer");
    expect(specialistId("  Release notes — writer!! ")).toBe("release-notes-writer");
    expect(specialistId("Café Ölçüm")).toBe("cafe-olcum");
    expect(specialistId("R2D2")).toBe("r2d2");
  });

  it("keeps letters of any script, as the runtime does", () => {
    expect(specialistId("论文写作")).toBe("论文写作");
    expect(specialistId("论文 写作 v2")).toBe("论文-写作-v2");
    expect(specialistId("データ解析")).toBe("データ解析");
    expect(specialistId("ガイド")).toBe("ガイド"); // voiced marks survive the accent fold
    expect(specialistId("논문 작성")).toBe("논문-작성");
    expect(specialistId("İstatistik")).toBe("istatistik");
  });

  it("yields nothing for a name without letters or digits", () => {
    expect(specialistId("---")).toBe("");
    expect(specialistId("！？")).toBe("");
  });

  it("caps the length without leaving a trailing hyphen", () => {
    const id = specialistId(`${"a".repeat(MAX_ID - 1)} b`);
    expect(id.length).toBeLessThanOrEqual(MAX_ID);
    expect(id.endsWith("-")).toBe(false);
    // Counted in characters, like the Rust side.
    expect(Array.from(specialistId("写".repeat(MAX_ID + 5)))).toHaveLength(MAX_ID);
  });
});

describe("connectors", () => {
  it("prefixes match the runtime's tool-name sanitizer", () => {
    expect(connectorPrefix("my server.v2")).toBe("my_server_v2");
    expect(connectorPrefix("open-science-browser")).toBe("open-science-browser");
  });

  it("flags a block that would also catch another connector's tools", () => {
    expect(connectorCollisions(["pubmed"], ["pubmed_central", "arxiv"])).toEqual([
      ["pubmed", "pubmed_central"],
    ]);
    expect(connectorCollisions(["pubmed"], ["pubmed-central"])).toEqual([]);
    expect(connectorCollisions(["pubmed_central"], ["pubmed"])).toEqual([]);
  });
});
