import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePlanSearchRuntimeConfig, runPlanSearch } from "./plan-search.js";

describe("plan-search", () => {
  it("selects the top-scoring candidate and returns planner metadata", () => {
    const result = runPlanSearch({
      prompt:
        "Add an opt-in feature flag for plan search, keep backward compatibility, persist metadata, and add tests.",
      runtimeConfig: {
        enabled: true,
        candidateCount: 4,
        scoringMode: "heuristic",
        includeSelectedPlanInPrompt: true,
      },
    });

    expect(result.considered).toHaveLength(4);
    expect(result.selected.id).toBe(result.meta.selectedCandidateId);
    expect(result.meta.considered).toHaveLength(4);
    expect(result.prompt).toContain("Selected execution plan (auto-selected before run):");

    const scores = result.considered.map((candidate) => candidate.score);
    const sorted = scores.toSorted((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  it("falls back to the first candidate when scoring fails", () => {
    const result = runPlanSearch({
      prompt: "Implement plan search MVP and keep fallback safety.",
      runtimeConfig: {
        enabled: true,
        candidateCount: 3,
        scoringMode: "heuristic",
        includeSelectedPlanInPrompt: true,
      },
      scorer: () => {
        throw new Error("forced scorer failure");
      },
    });

    expect(result.meta.scoringFailed).toBe(true);
    expect(result.meta.scoringError).toContain("forced scorer failure");
    expect(result.selected.id).toBe("plan-1");
    expect(result.meta.selectedCandidateId).toBe("plan-1");
    expect(result.meta.considered).toHaveLength(3);
  });

  it("resolves runtime config from agents.defaults.planSearch", () => {
    const cfg = {
      agents: {
        defaults: {
          planSearch: {
            enabled: true,
            candidates: 99,
            scoring: "llm",
            includeSelectedPlanInPrompt: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolvePlanSearchRuntimeConfig(cfg);
    expect(resolved).toEqual({
      enabled: true,
      candidateCount: 8,
      scoringMode: "llm",
      includeSelectedPlanInPrompt: false,
    });
  });
});
