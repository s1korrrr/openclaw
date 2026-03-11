import type { AgentLoopTraceSpan } from "../agent-loop-trace.js";
import { deriveEmbeddedPiRealizedOutcome } from "./self-calibration.js";
import type {
  EmbeddedPiPlanSearchMeta,
  EmbeddedPiRunMeta,
  EmbeddedPiTemporalCreditFactor,
  EmbeddedPiTemporalCreditMeta,
} from "./types.js";

const BASELINE_OUTCOME_SCORE = 0.35;

export type BuildEmbeddedPiTemporalCreditParams = {
  planSearch?: EmbeddedPiPlanSearchMeta;
  runMeta: Pick<EmbeddedPiRunMeta, "durationMs" | "aborted" | "error" | "stopReason">;
  payloadCount: number;
  didSendViaMessagingTool: boolean;
  successfulCronAdds?: number;
  traceSpans?: AgentLoopTraceSpan[];
};

export function buildEmbeddedPiTemporalCreditMeta(
  params: BuildEmbeddedPiTemporalCreditParams,
): EmbeddedPiTemporalCreditMeta | undefined {
  const traceSpans = params.traceSpans ?? [];
  if (!params.planSearch && traceSpans.length === 0) {
    return undefined;
  }

  const realized = deriveEmbeddedPiRealizedOutcome(params);
  const factors: EmbeddedPiTemporalCreditFactor[] = [];

  if (params.planSearch) {
    const contribution = params.planSearch.selectedWithinBudget ? 0.08 : -0.06;
    factors.push(
      buildFactor({
        id: "plan_search_budget_fit",
        label: params.planSearch.selectedWithinBudget
          ? "Plan search stayed within the configured budget"
          : "Plan search selected an over-budget candidate",
        stage: "plan",
        contribution,
        evidence: {
          reason: params.planSearch.selectedCandidateId,
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  const toolSpans = traceSpans.filter((span) => span.stage === "tool" && span.toolName);
  for (const factor of buildToolFactors(toolSpans, realized.outcomeScore)) {
    factors.push(factor);
  }

  const completedReplans = traceSpans.filter(
    (span) => span.stage === "replan" && span.status === "completed",
  ).length;
  if (completedReplans > 1) {
    factors.push(
      buildFactor({
        id: "replan_iterations",
        label: "Completed replan iterations recovered the run",
        stage: "replan",
        contribution: Math.min(0.09, completedReplans * 0.03),
        evidence: {
          count: completedReplans,
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  const hasVisibleOutput = params.payloadCount > 0 || params.didSendViaMessagingTool;
  factors.push(
    buildFactor({
      id: hasVisibleOutput ? "visible_output" : "missing_output",
      label: hasVisibleOutput
        ? "The run produced visible output for the operator"
        : "The run ended without visible operator output",
      stage: "observation",
      contribution: hasVisibleOutput ? 0.25 : -0.18,
      evidence: {
        count: params.payloadCount,
        reason: params.didSendViaMessagingTool ? "messaging_tool_delivery" : undefined,
      },
      observedOutcomeScore: realized.outcomeScore,
    }),
  );

  if (params.didSendViaMessagingTool) {
    factors.push(
      buildFactor({
        id: "messaging_delivery",
        label: "A messaging tool delivered the result",
        stage: "observation",
        contribution: 0.08,
        evidence: {
          reason: "messaging_tool_delivery",
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  if (params.successfulCronAdds && params.successfulCronAdds > 0) {
    factors.push(
      buildFactor({
        id: "cron_followup_creation",
        label: "The run created follow-up cron work",
        stage: "observation",
        contribution: Math.min(0.09, params.successfulCronAdds * 0.03),
        evidence: {
          count: params.successfulCronAdds,
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  if (params.runMeta.stopReason === "tool_calls") {
    factors.push(
      buildFactor({
        id: "unfinished_tool_loop",
        label: "The run stopped with pending tool work",
        stage: "observation",
        contribution: -0.07,
        evidence: {
          reason: "tool_calls",
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  } else if (params.runMeta.stopReason && !params.runMeta.error && !params.runMeta.aborted) {
    factors.push(
      buildFactor({
        id: "clean_stop",
        label: "The run exited cleanly after finishing its work",
        stage: "observation",
        contribution: 0.05,
        evidence: {
          reason: params.runMeta.stopReason,
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  if (params.runMeta.aborted) {
    factors.push(
      buildFactor({
        id: "aborted_run",
        label: "The run was aborted before full completion",
        stage: "observation",
        contribution: -0.12,
        evidence: {
          reason: "aborted",
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  if (params.runMeta.error) {
    factors.push(
      buildFactor({
        id: `error_${params.runMeta.error.kind}`,
        label: `The run ended with ${params.runMeta.error.kind}`,
        stage: "observation",
        contribution: -0.35,
        evidence: {
          reason: params.runMeta.error.kind,
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  const explainedOutcomeScore = clamp01(
    BASELINE_OUTCOME_SCORE + factors.reduce((sum, factor) => sum + factor.contribution, 0),
  );
  const residualContribution = roundMetric(realized.outcomeScore - explainedOutcomeScore);
  if (Math.abs(residualContribution) >= 0.02) {
    factors.push(
      buildFactor({
        id: "residual_outcome_gap",
        label: "Residual outcome not explained by the first-pass attribution factors",
        stage: "observation",
        contribution: residualContribution,
        evidence: {
          reason: "residual_gap",
        },
        observedOutcomeScore: realized.outcomeScore,
      }),
    );
  }

  if (factors.length === 0) {
    return undefined;
  }

  const topPositive = factors
    .filter((factor) => factor.direction === "positive")
    .toSorted((left, right) => right.contribution - left.contribution)[0];
  const topNegative = factors
    .filter((factor) => factor.direction === "negative")
    .toSorted((left, right) => left.contribution - right.contribution)[0];

  return {
    version: 1,
    heuristic: "evaluation_trace_ablation_v1",
    observedOutcome: realized.outcome,
    observedOutcomeScore: realized.outcomeScore,
    baselineOutcomeScore: BASELINE_OUTCOME_SCORE,
    topPositiveFactorId: topPositive?.id,
    topNegativeFactorId: topNegative?.id,
    factors: factors.toSorted(
      (left, right) => Math.abs(right.contribution) - Math.abs(left.contribution),
    ),
  };
}

function buildToolFactors(
  spans: AgentLoopTraceSpan[],
  observedOutcomeScore: number,
): EmbeddedPiTemporalCreditFactor[] {
  const byTool = new Map<
    string,
    {
      completed: number;
      failed: number;
      stepIds: string[];
    }
  >();

  for (const span of spans) {
    const toolName = span.toolName?.trim();
    if (!toolName) {
      continue;
    }
    const current = byTool.get(toolName) ?? { completed: 0, failed: 0, stepIds: [] };
    current.stepIds.push(span.stepId);
    if (span.status === "completed") {
      current.completed += 1;
    } else {
      current.failed += 1;
    }
    byTool.set(toolName, current);
  }

  return Array.from(byTool.entries())
    .map(([toolName, summary]) => {
      const contribution = roundMetric(
        Math.max(-0.2, Math.min(0.18, summary.completed * 0.04 - summary.failed * 0.07)),
      );
      if (contribution === 0) {
        return undefined;
      }
      return buildFactor({
        id: `tool_${toolName.replaceAll(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"}`,
        label:
          contribution > 0
            ? `${toolName} completed useful tool work`
            : `${toolName} introduced tool friction or failure`,
        stage: "tool",
        contribution,
        evidence: {
          toolName,
          count: summary.completed + summary.failed,
          stepIds: summary.stepIds,
        },
        observedOutcomeScore,
      });
    })
    .filter((factor): factor is EmbeddedPiTemporalCreditFactor => factor !== undefined);
}

function buildFactor(params: {
  id: string;
  label: string;
  stage: EmbeddedPiTemporalCreditFactor["stage"];
  contribution: number;
  evidence?: EmbeddedPiTemporalCreditFactor["evidence"];
  observedOutcomeScore: number;
}): EmbeddedPiTemporalCreditFactor {
  const contribution = roundMetric(params.contribution);
  return {
    id: params.id,
    label: params.label,
    stage: params.stage,
    direction: contribution >= 0 ? "positive" : "negative",
    contribution,
    counterfactualOutcomeScore: roundMetric(clamp01(params.observedOutcomeScore - contribution)),
    evidence: params.evidence,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}
