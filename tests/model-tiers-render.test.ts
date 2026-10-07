/**
 * Behavioral tests for the model-tiers IO ratio change.
 * Exercises exported renderTable and scoreModels with
 * synthetic data to verify the 99/1 split is reflected
 * in rendered output and blended cost computation.
 */
import { describe, it, expect } from "bun:test";
import { renderTable, scoreModels, scoreAllModels, isValidCache } from "../extensions/model-tiers/index";

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

// ---------------------------------------------------------------------------
// Partial AA coverage: unpublished indices must not score as zero
// ---------------------------------------------------------------------------

const BENCH = (rows: Array<Partial<{ slug: string; name: string; i: number | null; c: number | null; a: number | null }>>) => ({
  data: rows.map((r) => ({
    source: "artificial-analysis",
    model_permaslug: r.slug ?? "mock/a",
    display_name: r.name ?? "Mock A",
    intelligence_index: r.i ?? null,
    coding_index: r.c ?? null,
    agentic_index: r.a ?? null,
    pricing: { prompt: "1", completion: "5" },
  })),
});

const MODELS = (slugs: string[]) => ({
  data: slugs.map((s) => ({ id: s, canonical_slug: s, pricing: { prompt: "1", completion: "5" } })),
});

describe("partial AA rows", () => {
  const benchmarks = BENCH([
    { slug: "mock/complete", name: "Complete", i: 60, c: 70, a: 50 },
    { slug: "mock/partial-new", name: "Partial New", i: 55, c: null, a: null },
    { slug: "mock/below-floor", name: "Below Floor", i: 30, c: null, a: null },
    { slug: "mock/weak-coding", name: "Weak Coding", i: 60, c: 50, a: 50 },
  ]);
  const models = MODELS(["mock/complete", "mock/partial-new", "mock/below-floor", "mock/weak-coding"]);

  it("includes a partial row whose published index clears the threshold", () => {
    const scored = scoreModels(benchmarks, models);
    const partial = scored.find((m) => m.slug === "mock/partial-new");
    expect(partial).toBeDefined();
    expect(partial!.missingAxes).toEqual(["coding", "agentic"]);
  });

  it("never averages an unpublished index as zero", () => {
    const scored = scoreModels(benchmarks, models);
    const partial = scored.find((m) => m.slug === "mock/partial-new")!;
    // i=55 against bounds i:[30,60] -> 0.833; a zero-scored average would sit near 27.
    expect(partial.avg).toBeCloseTo(((55 - 30) / 30) * 100, 5);
    expect(partial.avg).toBeGreaterThan(50);
  });

  it("still drops a partial row whose published index is below the floor", () => {
    const scored = scoreModels(benchmarks, models);
    expect(scored.find((m) => m.slug === "mock/below-floor")).toBeUndefined();
  });

  it("still drops a complete row below the coding floor", () => {
    const scored = scoreModels(benchmarks, models);
    expect(scored.find((m) => m.slug === "mock/weak-coding")).toBeUndefined();
  });

  it("caps the average at 100 when a partial row holds the axis maximum", () => {
    const b = BENCH([
      { slug: "mock/complete", i: 50, c: 60, a: 40 },
      { slug: "mock/partial-high", i: 80, c: null, a: null },
    ]);
    const scored = scoreModels(b, MODELS(["mock/complete", "mock/partial-high"]));
    const high = scored.find((m) => m.slug === "mock/partial-high")!;
    expect(high.avg).toBe(100);
  });

  it("renders partial rows with a marker and a footnote", () => {
    const scored = scoreModels(benchmarks, models);
    const out = renderTable(scored, "TEST TABLE");
    expect(out).toContain("†");
    expect(out).toMatch(/averaged over published indices only/);
  });
});

describe("pricing joins", () => {
  it("prices a standard model from its standard entry, not a :batch variant", () => {
    const models = {
      data: [
        { id: "vendor/model-a", canonical_slug: "vendor/model-a-20260101", pricing: { prompt: "10", completion: "40", input_cache_read: "1" } },
        { id: "vendor/model-a:batch", canonical_slug: "vendor/model-a-20260101", pricing: { prompt: "5", completion: "20", input_cache_read: "0.5" } },
      ],
    };
    const scored = scoreModels(BENCH([{ slug: "vendor/model-a-20260101", name: "Model A", i: 60, c: 70, a: 50 }]), models);
    const m = scored.find((x) => x.slug === "vendor/model-a-20260101")!;
    expect(m).toBeDefined();
    // standard: 0.04*10 + 0.96*1 = 1.36 -> 1.36*0.99 + 40*0.01 = 1.7464 (batch would be 0.8732)
    expect(m.blendedCost).toBeCloseTo(1.7464, 5);
  });

  it("drops rows with no standard pricing instead of pricing them at $0", () => {
    const scored = scoreModels(BENCH([{ slug: "vendor/gone", name: "Gone", i: 60, c: 70, a: 50 }]), MODELS(["vendor/other"]));
    expect(scored).toHaveLength(0);
  });

  it("keeps a genuinely free model rankable with a finite, top value score", () => {
    const models = { data: [{ id: "vendor/free", canonical_slug: "vendor/free", pricing: { prompt: "0", completion: "0" } }] };
    const scored = scoreModels(BENCH([{ slug: "vendor/free", name: "Free", i: 60, c: 70, a: 50 }]), models);
    expect(scored).toHaveLength(1);
    expect(scored[0].blendedCost).toBe(0);
    expect(Number.isFinite(scored[0].valueScore)).toBe(true);
  });
});

describe("degenerate bounds", () => {
  it("returns a neutral 0.5 per axis when an axis has no spread", () => {
    const scored = scoreModels(BENCH([{ slug: "vendor/only", name: "Only", i: 50, c: 60, a: 40 }]), MODELS(["vendor/only"]));
    expect(scored).toHaveLength(1);
    expect(scored[0].avg).toBe(50);
  });

  it("keeps scoreAllModels free of negative averages", () => {
    const b = BENCH([
      { slug: "mock/a", i: 10, c: 20, a: 5 },
      { slug: "mock/b", i: 30, c: null, a: null },
      { slug: "mock/c", i: null, c: 70, a: null },
    ]);
    const scored = scoreAllModels(b, MODELS(["mock/a", "mock/b", "mock/c"]));
    expect(scored).toHaveLength(3);
    for (const m of scored) expect(m.avg).toBeGreaterThanOrEqual(0);
  });
});

describe("cache validation", () => {
  const payload = { benchmarks: { data: [] }, models: { data: [] } };
  const now = 1_000_000_000;

  it("accepts a fresh, well-formed cache", () => {
    expect(isValidCache({ ...payload, fetchedAt: now - 1000 }, now, 24 * 3600 * 1000)).toBe(true);
  });

  it("rejects a cache with a missing or non-finite fetchedAt", () => {
    expect(isValidCache({ ...payload }, now, 24 * 3600 * 1000)).toBe(false);
    expect(isValidCache({ ...payload, fetchedAt: NaN }, now, 24 * 3600 * 1000)).toBe(false);
  });

  it("rejects an expired cache", () => {
    expect(isValidCache({ ...payload, fetchedAt: now - 25 * 3600 * 1000 }, now, 24 * 3600 * 1000)).toBe(false);
  });

  it("rejects payloads whose data fields are not arrays", () => {
    expect(isValidCache({ fetchedAt: now, benchmarks: { data: {} }, models: { data: [] } }, now, 24 * 3600 * 1000)).toBe(false);
  });
});
