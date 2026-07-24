/**
 * Behavioral tests for the model-tiers IO ratio change.
 * Exercises exported renderTable and scoreModels with
 * synthetic data to verify the 99/1 split is reflected
 * in rendered output and blended cost computation.
 */
import { describe, it, expect } from "bun:test";
import { renderTable, scoreModels } from "../extensions/model-tiers/index";

// ---------------------------------------------------------------------------
// Synthetic AA-like benchmark data for blended-cost testing
// ---------------------------------------------------------------------------

const MOCK_BENCHMARKS = {
  data: [
    {
      source: "artificial-analysis",
      model_permaslug: "mock-model-a",
      display_name: "Mock Model A",
      intelligence_index: 60,
      coding_index: 70,
      agentic_index: 50,
      pricing: { prompt: "2", completion: "10" },
    },
    {
      source: "artificial-analysis",
      model_permaslug: "mock-model-b",
      display_name: "Mock Model B",
      intelligence_index: 55,
      coding_index: 65,
      agentic_index: 45,
      pricing: { prompt: "1", completion: "5" },
    },
  ],
};

const MOCK_MODELS = {
  data: [
    {
      id: "mock-model-a",
      canonical_slug: "mock-model-a",
      pricing: { prompt: "2", completion: "10" },
    },
    {
      id: "mock-model-b",
      canonical_slug: "mock-model-b",
      pricing: { prompt: "1", completion: "5" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderTable header", () => {
  it("contains '99/1 I/O' in the rendered header when given a scored model", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const output = renderTable(models, "TEST TABLE");
    expect(output).toMatch(/99\/1 I\/O/);
  });

  it("does NOT contain '75/25 I/O' in the rendered header", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const output = renderTable(models, "TEST TABLE");
    expect(output).not.toMatch(/75\/25 I\/O/);
  });

  it("renders the title and dim header line", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const output = renderTable(models, "MY TITLE");
    expect(output).toContain("MY TITLE");
    expect(output).toMatch(/96% cache/);
    expect(output).toMatch(/99\/1 I\/O/);
  });
});

describe("scoreModels blended cost", () => {
  it("computes blended cost using 99/1 ratio for a model with pricing", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const modelA = models.find((m) => m.slug === "mock-model-a");
    expect(modelA).toBeDefined();
    // promptPrice=2, completionPrice=10, no cacheRead → effectiveInput = promptPrice = 2
    // blended = 2 * 0.99 + 10 * 0.01 = 1.98 + 0.10 = 2.08
    expect(modelA!.blendedCost).toBeCloseTo(2.08, 5);
    expect(modelA!.promptPrice).toBe(2);
    expect(modelA!.completionPrice).toBe(10);
  });

  it("computes blended cost differently than old 75/25 ratio", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const modelB = models.find((m) => m.slug === "mock-model-b");
    expect(modelB).toBeDefined();
    // promptPrice=1, completionPrice=5, no cacheRead → effectiveInput = 1
    // blended (99/1) = 1 * 0.99 + 5 * 0.01 = 0.99 + 0.05 = 1.04
    // old blended (75/25) = 1 * 0.75 + 5 * 0.25 = 0.75 + 1.25 = 2.00
    expect(modelB!.blendedCost).toBeCloseTo(1.04, 5);
    // Confirm it's NOT the old 75/25 value
    expect(modelB!.blendedCost).not.toBeCloseTo(2.0, 5);
  });

  it("handles cacheRead pricing with 99/1 ratio", () => {
    // Model with cacheRead pricing
    const cacheBenchmarks = {
      data: [
        {
          source: "artificial-analysis",
          model_permaslug: "cache-model",
          display_name: "Cache Model",
          intelligence_index: 60,
          coding_index: 70,
          agentic_index: 50,
          pricing: { prompt: "10", completion: "40" },
        },
      ],
    };
    const cacheModels = {
      data: [
        {
          id: "cache-model",
          canonical_slug: "cache-model",
          pricing: {
            prompt: "10",
            completion: "40",
            input_cache_read: "0.5",
          },
        },
      ],
    };
    const models = scoreModels(cacheBenchmarks, cacheModels);
    const m = models.find((x) => x.slug === "cache-model");
    expect(m).toBeDefined();
    // effectiveInput = MISS_RATE(0.04) * prompt(10) + CACHE_HIT_RATE(0.96) * cacheRead(0.5)
    //               = 0.04*10 + 0.96*0.5 = 0.4 + 0.48 = 0.88
    // blended = 0.88 * 0.99 + 40 * 0.01 = 0.8712 + 0.4 = 1.2712
    expect(m!.blendedCost).toBeCloseTo(1.2712, 5);
    // Old ratio would be: 0.88 * 0.75 + 40 * 0.25 = 0.66 + 10.0 = 10.66
    expect(m!.blendedCost).not.toBeCloseTo(10.66, 5);
  });
});

describe("source-level invariants (supplementary)", () => {
  it("source file contains CACHE_HIT_RATE = 0.96, MISS_RATE = 0.04, INPUT_RATIO = 0.99, OUTPUT_RATIO = 0.01", async () => {
    const src = await Bun.file("extensions/model-tiers/index.ts").text();
    expect(src).toMatch(/CACHE_HIT_RATE\s*=\s*0\.96/);
    expect(src).toMatch(/MISS_RATE\s*=\s*0\.04/);
    expect(src).toMatch(/INPUT_RATIO\s*=\s*0\.99/);
    expect(src).toMatch(/OUTPUT_RATIO\s*=\s*0\.01/);
  });

  it("source file does NOT contain old 0.75 or 0.25 numeric literals belonging to the split", async () => {
    const src = await Bun.file("extensions/model-tiers/index.ts").text();
    expect(src).not.toMatch(/\b0\.75\b/);
    expect(src).not.toMatch(/\b0\.25\b/);
  });
});
