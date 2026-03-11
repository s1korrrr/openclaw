import type {
  EmbeddedPiPlanSearchMeta,
  EmbeddedPiRunMeta,
  EmbeddedPiSelfCalibrationMeta,
} from "./types.js";

const MATCH_TOLERANCE = 0.15;

export type BuildEmbeddedPiSelfCalibrationParams = {
  planSearch?: EmbeddedPiPlanSearchMeta;
  runMeta: Pick<EmbeddedPiRunMeta, "durationMs" | "aborted" | "error" | "stopReason">;
  payloadCount: number;
  didSendViaMessagingTool: boolean;
};

export function buildEmbeddedPiSelfCalibrationMeta(
  params: BuildEmbeddedPiSelfCalibrationParams,
): EmbeddedPiSelfCalibrationMeta | undefined {
  const planSearch = params.planSearch;
  if (!planSearch) {
    return undefined;
  }

  const predictedConfidence = derivePredictedConfidence(planSearch);
  const realized = deriveRealizedOutcome(params);
  const realizedMinusPredicted = roundMetric(realized.outcomeScore - predictedConfidence);
  const verdict =
    Math.abs(realizedMinusPredicted) <= MATCH_TOLERANCE
      ? "matched"
      : realizedMinusPredicted < 0
        ? "underperformed"
        : "outperformed";

  return {
    version: 1,
    heuristic: "plan_search_vs_terminal_run_v1",
    predicted: {
      source: "plan_search",
      selectedCandidateId: planSearch.selectedCandidateId,
      candidateCount: planSearch.candidateCount,
      selectedScore: roundMetric(planSearch.selectedScore),
      normalizedConfidence: predictedConfidence,
      performanceGain: roundMetric(planSearch.selectedPerformanceGain),
      computeCost: roundMetric(planSearch.selectedComputeCost),
      withinBudget: planSearch.selectedWithinBudget,
    },
    realized: {
      source: "terminal_run",
      durationMs: params.runMeta.durationMs,
      payloadCount: params.payloadCount,
      didSendViaMessagingTool: params.didSendViaMessagingTool,
      aborted: params.runMeta.aborted ?? false,
      stopReason: params.runMeta.stopReason,
      errorKind: params.runMeta.error?.kind,
      ...realized,
    },
    delta: {
      realizedMinusPredicted,
      confidenceDelta: roundMetric(realizedMinusPredicted / 2),
      verdict,
    },
  };
}

function derivePredictedConfidence(planSearch: EmbeddedPiPlanSearchMeta): number {
  const sortedScores = planSearch.considered
    .map((candidate) => candidate.score)
    .filter((score) => Number.isFinite(score))
    .toSorted((a, b) => b - a);
  const selectedScore = Number.isFinite(planSearch.selectedScore)
    ? planSearch.selectedScore
    : (sortedScores[0] ?? 0);
  const runnerUpScore =
    sortedScores.find((score) => score < selectedScore) ?? sortedScores[1] ?? selectedScore;
  const scale = Math.max(1, Math.abs(selectedScore), Math.abs(runnerUpScore));
  const relativeMargin = clamp01((selectedScore - runnerUpScore) / scale);
  const predicted =
    0.45 +
    relativeMargin * 0.35 +
    (planSearch.selectedWithinBudget ? 0.15 : -0.1) +
    (planSearch.scoringFailed ? -0.1 : 0);
  return roundMetric(clamp01(predicted));
}

function deriveRealizedOutcome(
  params: BuildEmbeddedPiSelfCalibrationParams,
): Pick<EmbeddedPiSelfCalibrationMeta["realized"], "outcome" | "outcomeScore"> {
  const hasVisibleOutput = params.payloadCount > 0 || params.didSendViaMessagingTool;

  if (params.runMeta.error) {
    return { outcome: "failed", outcomeScore: 0 };
  }

  const outcome =
    hasVisibleOutput && !params.runMeta.aborted
      ? "completed"
      : hasVisibleOutput || params.runMeta.aborted || params.runMeta.stopReason === "tool_calls"
        ? "partial"
        : "failed";

  let outcomeScore = outcome === "completed" ? 0.8 : outcome === "partial" ? 0.45 : 0.1;
  if (hasVisibleOutput) {
    outcomeScore += 0.1;
  }
  if (params.runMeta.stopReason && params.runMeta.stopReason !== "tool_calls") {
    outcomeScore += 0.05;
  }
  if (params.runMeta.aborted) {
    outcomeScore -= 0.1;
  }

  return {
    outcome,
    outcomeScore: roundMetric(clamp01(outcomeScore)),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}
