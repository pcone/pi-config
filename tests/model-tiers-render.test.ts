/**
 * Behavioral tests for the model-tiers IO ratio change.
 * Exercises exported renderTable and scoreModels with
 * synthetic data to verify the 90/10 split is reflected
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
  it("contains '90/10 I/O' in the rendered header when given a scored model", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const output = renderTable(models, "TEST TABLE");
    expect(output).toMatch(/90\/10 I\/O/);
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
    expect(output).toMatch(/98% cache/);
    expect(output).toMatch(/90\/10 I\/O/);
  });
});

describe("scoreModels blended cost", () => {
  it("computes blended cost using 90/10 ratio for a model with pricing", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const modelA = models.find((m) => m.slug === "mock-model-a");
    expect(modelA).toBeDefined();
    // promptPrice=2, completionPrice=10, no cacheRead → effectiveInput = promptPrice = 2
    // blended = 2 * 0.90 + 10 * 0.10 = 1.80 + 1.00 = 2.80
    expect(modelA!.blendedCost).toBeCloseTo(2.8, 5);
    expect(modelA!.promptPrice).toBe(2);
    expect(modelA!.completionPrice).toBe(10);
  });

  it("computes blended cost differently than old 75/25 ratio", () => {
    const models = scoreModels(MOCK_BENCHMARKS, MOCK_MODELS);
    const modelB = models.find((m) => m.slug === "mock-model-b");
    expect(modelB).toBeDefined();
    // promptPrice=1, completionPrice=5, no cacheRead → effectiveInput = 1
    // blended (90/10) = 1 * 0.90 + 5 * 0.10 = 0.90 + 0.50 = 1.40
    // old blended (75/25) = 1 * 0.75 + 5 * 0.25 = 0.75 + 1.25 = 2.00
    expect(modelB!.blendedCost).toBeCloseTo(1.4, 5);
    // Confirm it's NOT the old 75/25 value
    expect(modelB!.blendedCost).not.toBeCloseTo(2.0, 5);
  });

  it("handles cacheRead pricing with 90/10 ratio", () => {
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
    // effectiveInput = MISS_RATE(0.02) * prompt(10) + CACHE_HIT_RATE(0.98) * cacheRead(0.5)
    //               = 0.02*10 + 0.98*0.5 = 0.2 + 0.49 = 0.69
    // blended = 0.69 * 0.90 + 40 * 0.10 = 0.621 + 4.0 = 4.621
    expect(m!.blendedCost).toBeCloseTo(4.621, 5);
    // Old ratio would be: 0.69 * 0.75 + 40 * 0.25 = 0.5175 + 10.0 = 10.5175
    expect(m!.blendedCost).not.toBeCloseTo(10.5175, 5);
  });
});

describe("source-level invariants (supplementary)", () => {
  it("source file contains INPUT_RATIO = 0.90 and OUTPUT_RATIO = 0.10", async () => {
    const src = await Bun.file("extensions/model-tiers/index.ts").text();
    expect(src).toMatch(/INPUT_RATIO\s*=\s*0\.90/);
    expect(src).toMatch(/OUTPUT_RATIO\s*=\s*0\.10/);
  });

  it("source file does NOT contain old 0.75 or 0.25 numeric literals belonging to the split", async () => {
    const src = await Bun.file("extensions/model-tiers/index.ts").text();
    expect(src).not.toMatch(/\b0\.75\b/);
    expect(src).not.toMatch(/\b0\.25\b/);
  });
});
