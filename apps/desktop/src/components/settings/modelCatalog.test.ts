import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import {
  fallbackDefaultModel,
  filterModelOptions,
  flattenModelOptions,
  selectableModelOptions,
  type ModelFilter,
} from "./modelCatalog";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "o3", name: "o3" },
    ],
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    models: [{ id: "qwen3-coder", name: "Qwen3 Coder" }],
  },
];

const options = flattenModelOptions(providers);
const favorites = ["openai/o3", "missing/model"];
const recent = ["ollama-cloud/qwen3-coder", "openai/gpt-5.2", "missing/model"];

describe("model catalog", () => {
  it("flattens providers into canonical model options without changing order", () => {
    expect(options.map((m) => m.key)).toEqual([
      "openai/gpt-5.2",
      "openai/o3",
      "ollama-cloud/qwen3-coder",
    ]);
  });

  it.each([
    ["gpt-5.2", ["openai/gpt-5.2"]],
    ["QWEN3", ["ollama-cloud/qwen3-coder"]],
    ["ollama cloud", ["ollama-cloud/qwen3-coder"]],
    ["OPENAI", ["openai/gpt-5.2", "openai/o3"]],
  ])("searches model names, ids, and providers with query %s", (query, expected) => {
    expect(filterModelOptions(options, { kind: "all" }, query, favorites, recent).map((m) => m.key))
      .toEqual(expected);
  });

  it("filters favorites while keeping unavailable favorites outside the visible list", () => {
    expect(filterModelOptions(options, { kind: "favorites" }, "", favorites, recent).map((m) => m.key))
      .toEqual(["openai/o3"]);
  });

  it("preserves recent preference order", () => {
    expect(filterModelOptions(options, { kind: "recent" }, "", favorites, recent).map((m) => m.key))
      .toEqual(["ollama-cloud/qwen3-coder", "openai/gpt-5.2"]);
  });

  it("limits a provider filter (an empty query filters nothing away)", () => {
    const filter: ModelFilter = { kind: "provider", providerID: "openai" };
    expect(filterModelOptions(options, filter, "", favorites, recent).map((m) => m.key))
      .toEqual(["openai/gpt-5.2", "openai/o3"]);
    expect(filterModelOptions(options, { kind: "all" }, "", favorites, recent)).toHaveLength(3);
  });
});

describe("fallbackDefaultModel", () => {
  it("leaves an available default alone", () => {
    expect(fallbackDefaultModel(providers, "openai/o3")).toBeNull();
  });

  it("re-points a renamed model at the same provider's first model", () => {
    expect(fallbackDefaultModel(providers, "openai/gpt-4-old")).toBe("openai/gpt-5.2");
  });

  it("falls back to the first provider when the default's provider is gone", () => {
    expect(fallbackDefaultModel(providers, "mydog/gpt-5.6-sol")).toBe("openai/gpt-5.2");
  });

  it("has nothing to offer when no models exist", () => {
    expect(fallbackDefaultModel([], "openai/o3")).toBeNull();
    expect(fallbackDefaultModel([{ id: "empty", name: "Empty", models: [] }], "empty/x")).toBeNull();
  });

  it("leaves a retired default alone when it is not known to be free", () => {
    expect(fallbackDefaultModel(retiredProviders, "zen/dead")).toBeNull();
  });

  it("re-points a retired free default at a free model of the same provider", () => {
    // Zen stopped serving a free model before the catalog marked it deprecated:
    // every turn failed, though a free model of the same provider was there.
    const zen: ProviderInfo[] = [
      {
        id: "zen",
        name: "Zen",
        models: [
          { id: "longcat-free", name: "LongCat", available: false, free: true },
          { id: "paid", name: "Paid", available: true, free: false },
          { id: "other-retired-free", name: "Gone", available: false, free: true },
          { id: "deepseek-free", name: "DeepSeek", available: true, free: true },
        ],
      },
      { id: "local", name: "Local", models: [{ id: "llama", name: "Llama", free: true }] },
    ];
    expect(fallbackDefaultModel(zen, "zen/longcat-free")).toBe("zen/deepseek-free");
  });

  it("never moves a retired default onto a paid model or another provider", () => {
    const onlyPaid: ProviderInfo[] = [
      {
        id: "zen",
        name: "Zen",
        models: [
          { id: "longcat-free", name: "LongCat", available: false, free: true },
          { id: "paid", name: "Paid", available: true, free: false },
        ],
      },
      { id: "local", name: "Local", models: [{ id: "llama", name: "Llama", free: true }] },
    ];
    expect(fallbackDefaultModel(onlyPaid, "zen/longcat-free")).toBeNull();
    const retiredPaid: ProviderInfo[] = [
      {
        id: "zen",
        name: "Zen",
        models: [
          { id: "old-paid", name: "Old", available: false, free: false },
          { id: "free", name: "Free", available: true, free: true },
        ],
      },
    ];
    expect(fallbackDefaultModel(retiredPaid, "zen/old-paid")).toBeNull();
  });

  it("never re-points a dangling default at a retired model", () => {
    expect(fallbackDefaultModel(retiredProviders, "zen/renamed-away")).toBe("zen/live");
  });
});

// A provider that still advertises a model it no longer serves — Zen's actual
// state for 19 of its 25 free models.
const retiredProviders: ProviderInfo[] = [
  {
    id: "zen",
    name: "Zen",
    models: [
      { id: "dead", name: "Dead", available: false },
      { id: "live", name: "Live", available: true },
    ],
  },
];

describe("retired models", () => {
  const retired = flattenModelOptions(retiredProviders);

  it("reads a model with no availability info as available", () => {
    expect(options.every((m) => m.available)).toBe(true);
  });

  it("keeps retired models out of every list a user picks from", () => {
    expect(selectableModelOptions(retired).map((m) => m.key)).toEqual(["zen/live"]);
    for (const filter of [
      { kind: "all" } as ModelFilter,
      { kind: "favorites" } as ModelFilter,
      { kind: "recent" } as ModelFilter,
      { kind: "provider", providerID: "zen" } as ModelFilter,
    ]) {
      const visible = filterModelOptions(retired, filter, "", ["zen/dead"], ["zen/dead"]);
      expect(visible.map((m) => m.key)).not.toContain("zen/dead");
    }
  });

  it("still resolves a retired model by key, so a configured one can be named", () => {
    expect(retired.find((m) => m.key === "zen/dead")?.modelName).toBe("Dead");
  });
});
