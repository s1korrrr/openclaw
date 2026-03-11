import type {
  EmbeddedPiGenomeMutationPrimitive,
  EmbeddedPiGenomeStoreMeta,
  EmbeddedPiPlanSearchMeta,
} from "./types.js";

export function buildEmbeddedPiGenomeStoreMeta(params: {
  runId: string;
  planSearch?: EmbeddedPiPlanSearchMeta;
}): EmbeddedPiGenomeStoreMeta | undefined {
  const planSearch = params.planSearch;
  if (!planSearch || planSearch.considered.length === 0) {
    return undefined;
  }

  return {
    version: 1,
    heuristic: "plan_search_genome_store_v1",
    selectedFragmentId: planSearch.selectedCandidateId,
    fragments: planSearch.considered.map((candidate) => ({
      fragmentId: candidate.id,
      title: candidate.title,
      strategy: candidate.strategy,
      summary: `${candidate.title} (${candidate.strategy}) with ${candidate.steps.length} steps`,
      steps: [...candidate.steps],
      selected: candidate.id === planSearch.selectedCandidateId,
      score: candidate.score,
      performanceGain: candidate.performanceGain,
      computeCost: candidate.computeCost,
      withinBudget: candidate.withinBudget,
      rationale: [...candidate.rationale],
      mutationPrimitives: buildMutationPrimitives(candidate),
      provenance: {
        source: "plan_search_candidate",
        sourceRunId: params.runId,
        objective: planSearch.objective,
        candidateId: candidate.id,
        selectedCandidateId: planSearch.selectedCandidateId,
      },
    })),
  };
}

function buildMutationPrimitives(
  candidate: EmbeddedPiPlanSearchMeta["considered"][number],
): EmbeddedPiGenomeMutationPrimitive[] {
  const primitives: EmbeddedPiGenomeMutationPrimitive[] = [];

  if (!candidate.withinBudget || candidate.budgetViolations.length > 0) {
    primitives.push({
      kind: "tighten_budget",
      reason: `Reduce ${candidate.budgetViolations.join(", ")} pressure before reevaluating this fragment.`,
      target: candidate.budgetViolations.join(","),
    });
  }

  const longestStep = candidate.steps.toSorted((left, right) => right.length - left.length)[0];
  if (candidate.steps.length > 4 && longestStep) {
    primitives.push({
      kind: "drop_step",
      reason:
        "Trim the longest step first to keep the fragment reviewable and cheaper to evaluate.",
      target: longestStep,
    });
  }

  if (!candidate.rationale.some((item) => item.includes("validation"))) {
    primitives.push({
      kind: "promote_validation",
      reason: "Insert a validation step so the fragment keeps an explicit verification path.",
    });
  }

  if (candidate.strategy !== "trace-first") {
    primitives.push({
      kind: "swap_strategy_focus",
      reason: "Try the same fragment with a trace-first framing to compare evidence quality.",
      target: "trace-first",
    });
  }

  return primitives;
}
