import { describe, expect, it } from "vitest";
import { buildEmbeddedPiGenomeStoreMeta } from "./genome-store.js";
import type { EmbeddedPiPlanSearchMeta } from "./types.js";

function createPlanSearchMeta(): EmbeddedPiPlanSearchMeta {
  return {
    enabled: true,
    candidateCount: 2,
    configuredScoringMode: "heuristic",
    appliedScoringMode: "heuristic",
    objective: "performance_gain / compute_cost",
    selectedCandidateId: "plan-1",
    selectedScore: 7,
    selectedPerformanceGain: 8,
    selectedComputeCost: 0.9,
    selectedWithinBudget: true,
    promptIncludesSelectedPlan: true,
    budget: {
      maxTokens: 2_048,
      maxRuntimeMs: 120_000,
      maxCostUsd: 0.05,
      withinBudgetCount: 1,
      overBudgetCount: 1,
    },
    considered: [
      {
        id: "plan-1",
        title: "Trace-first implementation",
        strategy: "trace-first",
        steps: [
          "Trace the current runtime path.",
          "Insert the genome store seam.",
          "Persist fragment provenance in run metadata.",
          "Run focused tests and build validation.",
        ],
        score: 7,
        performanceGain: 8,
        computeCost: 0.9,
        estimatedTokens: 1_200,
        estimatedRuntimeMs: 70_000,
        estimatedCostUsd: 0.01,
        withinBudget: true,
        budgetViolations: [],
        rationale: ["has-validation", "mentions-artifacts"],
        stepCount: 4,
      },
      {
        id: "plan-2",
        title: "Safety-first rollout",
        strategy: "safety-first",
        steps: [
          "Document compatibility constraints before changing runtime behavior.",
          "Generate the fragment store metadata.",
          "Persist the fragment contract.",
          "Add regression coverage.",
          "Run the full validation set before merge.",
        ],
        score: 5,
        performanceGain: 6,
        computeCost: 1.7,
        estimatedTokens: 2_500,
        estimatedRuntimeMs: 140_000,
        estimatedCostUsd: 0.07,
        withinBudget: false,
        budgetViolations: ["tokens", "runtime_ms", "cost_usd"],
        rationale: ["mentions-compat-or-fallback"],
        stepCount: 5,
      },
    ],
  };
}

describe("embedded genome store", () => {
  it("derives reusable fragments with provenance and mutation primitives from plan-search candidates", () => {
    const genomeStore = buildEmbeddedPiGenomeStoreMeta({
      runId: "run-genome-1",
      planSearch: createPlanSearchMeta(),
    });

    expect(genomeStore?.heuristic).toBe("plan_search_genome_store_v1");
    expect(genomeStore?.selectedFragmentId).toBe("plan-1");
    expect(genomeStore?.fragments).toHaveLength(2);
    expect(genomeStore?.fragments[0]).toMatchObject({
      fragmentId: "plan-1",
      selected: true,
      provenance: {
        source: "plan_search_candidate",
        sourceRunId: "run-genome-1",
        candidateId: "plan-1",
      },
    });
    expect(genomeStore?.fragments[1]?.mutationPrimitives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tighten_budget" }),
        expect.objectContaining({ kind: "drop_step" }),
        expect.objectContaining({ kind: "promote_validation" }),
        expect.objectContaining({ kind: "swap_strategy_focus", target: "trace-first" }),
      ]),
    );
  });

  it("returns undefined when no plan-search metadata exists", () => {
    expect(buildEmbeddedPiGenomeStoreMeta({ runId: "run-genome-2" })).toBeUndefined();
  });
});
