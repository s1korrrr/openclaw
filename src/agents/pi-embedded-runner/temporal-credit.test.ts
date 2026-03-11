import { describe, expect, it } from "vitest";
import type { AgentLoopTraceSpan } from "../agent-loop-trace.js";
import { buildEmbeddedPiTemporalCreditMeta } from "./temporal-credit.js";
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
        steps: [
          "Trace the current runtime path.",
          "Implement the smallest safe slice.",
          "Persist metadata for replay.",
          "Run focused tests.",
          "Ship the change with validation notes.",
        ],
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
    ],
    ...overrides,
  };
}

function createToolSpan(overrides: Partial<AgentLoopTraceSpan> = {}): AgentLoopTraceSpan {
  return {
    ts: 1,
    seq: 1,
    type: "agent.loop.span",
    runId: "run-1",
    stage: "tool",
    stepId: "tool-0001",
    stepIndex: 1,
    startedAtMs: 10,
    endedAtMs: 20,
    durationMs: 10,
    status: "completed",
    toolName: "web.search",
    ...overrides,
  };
}

describe("embedded temporal credit", () => {
  it("builds positive and negative attribution factors from trace evidence", () => {
    const report = buildEmbeddedPiTemporalCreditMeta({
      planSearch: createPlanSearchMeta(),
      runMeta: {
        durationMs: 2_500,
        stopReason: "stop",
      },
      payloadCount: 1,
      didSendViaMessagingTool: true,
      successfulCronAdds: 1,
      traceSpans: [
        createToolSpan(),
        createToolSpan({
          stepId: "tool-0002",
          toolName: "bash.exec",
          status: "failed",
        }),
      ],
    });

    expect(report).toBeDefined();
    expect(report?.heuristic).toBe("evaluation_trace_ablation_v1");
    expect(report?.observedOutcome).toBe("completed");
    expect(report?.topPositiveFactorId).toBe("visible_output");
    expect(report?.topNegativeFactorId).toBe("tool_bash_exec");
    expect(report?.factors.map((factor) => factor.id)).toContain("tool_web_search");
    expect(report?.factors.map((factor) => factor.id)).toContain("tool_bash_exec");
    expect(report?.factors.find((factor) => factor.id === "messaging_delivery")?.direction).toBe(
      "positive",
    );
  });

  it("returns undefined when no trace or planner evidence exists", () => {
    expect(
      buildEmbeddedPiTemporalCreditMeta({
        runMeta: {
          durationMs: 900,
        },
        payloadCount: 1,
        didSendViaMessagingTool: false,
      }),
    ).toBeUndefined();
  });
});
