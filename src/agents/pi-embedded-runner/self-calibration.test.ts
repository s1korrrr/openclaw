import { describe, expect, it } from "vitest";
import { buildEmbeddedPiSelfCalibrationMeta } from "./self-calibration.js";
import type { EmbeddedPiPlanSearchMeta } from "./types.js";

function createPlanSearchMeta(
  overrides: Partial<EmbeddedPiPlanSearchMeta> = {},
): EmbeddedPiPlanSearchMeta {
  return {
    enabled: true,
    candidateCount: 3,
    configuredScoringMode: "heuristic",
    appliedScoringMode: "heuristic",
    objective: "performance_gain / compute_cost",
    selectedCandidateId: "plan-1",
    selectedScore: 6,
    selectedPerformanceGain: 7.5,
    selectedComputeCost: 1.1,
    selectedWithinBudget: true,
    promptIncludesSelectedPlan: true,
    budget: {
      maxTokens: 2048,
      maxRuntimeMs: 90_000,
      maxCostUsd: 0.05,
      withinBudgetCount: 3,
      overBudgetCount: 0,
    },
    considered: [
      {
        id: "plan-1",
        title: "Trace-first",
        strategy: "trace-first",
        score: 6,
        performanceGain: 7.5,
        computeCost: 1.1,
        estimatedTokens: 1200,
        estimatedRuntimeMs: 20_000,
        estimatedCostUsd: 0.01,
        withinBudget: true,
        budgetViolations: [],
        rationale: ["has-validation"],
        stepCount: 5,
      },
      {
        id: "plan-2",
        title: "Safety-first",
        strategy: "safety-first",
        score: 4.5,
        performanceGain: 6.2,
        computeCost: 1.2,
        estimatedTokens: 1500,
        estimatedRuntimeMs: 24_000,
        estimatedCostUsd: 0.015,
        withinBudget: true,
        budgetViolations: [],
        rationale: ["mentions-compat-or-fallback"],
        stepCount: 5,
      },
      {
        id: "plan-3",
        title: "Vertical slice",
        strategy: "vertical-slice",
        score: 3.8,
        performanceGain: 5,
        computeCost: 1.3,
        estimatedTokens: 1700,
        estimatedRuntimeMs: 28_000,
        estimatedCostUsd: 0.018,
        withinBudget: true,
        budgetViolations: [],
        rationale: ["mentions-artifacts"],
        stepCount: 5,
      },
    ],
    ...overrides,
  };
}

describe("embedded self-calibration", () => {
  it("marks a strong completed run as outperforming the planner confidence", () => {
    const report = buildEmbeddedPiSelfCalibrationMeta({
      planSearch: createPlanSearchMeta(),
      runMeta: {
        durationMs: 2_500,
        stopReason: "stop",
      },
      payloadCount: 1,
      didSendViaMessagingTool: false,
    });

    expect(report).toBeDefined();
    expect(report?.predicted.source).toBe("plan_search");
    expect(report?.predicted.normalizedConfidence).toBeGreaterThan(0.6);
    expect(report?.realized.outcome).toBe("completed");
    expect(report?.realized.outcomeScore).toBe(0.95);
    expect(report?.delta.verdict).toBe("outperformed");
    expect(report?.delta.confidenceDelta ?? 0).toBeGreaterThan(0);
  });

  it("marks failed runs as underperforming and recommends a negative confidence adjustment", () => {
    const report = buildEmbeddedPiSelfCalibrationMeta({
      planSearch: createPlanSearchMeta(),
      runMeta: {
        durationMs: 1_100,
        error: {
          kind: "retry_limit",
          message: "Exceeded retry limit.",
        },
      },
      payloadCount: 0,
      didSendViaMessagingTool: false,
    });

    expect(report?.realized.outcome).toBe("failed");
    expect(report?.realized.outcomeScore).toBe(0);
    expect(report?.realized.errorKind).toBe("retry_limit");
    expect(report?.delta.verdict).toBe("underperformed");
    expect(report?.delta.confidenceDelta ?? 0).toBeLessThan(0);
  });

  it("returns undefined when no prediction source exists", () => {
    expect(
      buildEmbeddedPiSelfCalibrationMeta({
        runMeta: { durationMs: 500 },
        payloadCount: 1,
        didSendViaMessagingTool: false,
      }),
    ).toBeUndefined();
  });
});
