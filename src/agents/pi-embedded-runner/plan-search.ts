import type { OpenClawConfig } from "../../config/config.js";
import type { EmbeddedPiPlanSearchMeta } from "./types.js";

const DEFAULT_PLAN_CANDIDATE_COUNT = 4;
const MIN_PLAN_CANDIDATE_COUNT = 2;
const MAX_PLAN_CANDIDATE_COUNT = 8;
const MAX_KEYWORDS = 6;

const PLAN_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "before",
  "build",
  "change",
  "changes",
  "feature",
  "first",
  "from",
  "have",
  "into",
  "just",
  "make",
  "need",
  "only",
  "plan",
  "runtime",
  "should",
  "task",
  "that",
  "then",
  "this",
  "with",
  "without",
]);

export type PlanSearchRuntimeConfig = {
  enabled: boolean;
  candidateCount: number;
  scoringMode: "heuristic" | "llm";
  includeSelectedPlanInPrompt: boolean;
};

type PlanCandidate = {
  id: string;
  title: string;
  strategy: string;
  steps: string[];
};

export type ScoredPlanCandidate = PlanCandidate & {
  score: number;
  rationale: string[];
};

export type PlanScoreResult = {
  score: number;
  rationale: string[];
};

export type PlanCandidateScorer = (candidate: PlanCandidate) => PlanScoreResult;

export type PlanSearchResult = {
  prompt: string;
  selected: ScoredPlanCandidate;
  considered: ScoredPlanCandidate[];
  meta: EmbeddedPiPlanSearchMeta;
};

function clampCandidateCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PLAN_CANDIDATE_COUNT;
  }
  const normalized = Math.trunc(value);
  return Math.min(MAX_PLAN_CANDIDATE_COUNT, Math.max(MIN_PLAN_CANDIDATE_COUNT, normalized));
}

function extractPromptKeywords(prompt: string): string[] {
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !PLAN_STOP_WORDS.has(token));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
    if (unique.length >= MAX_KEYWORDS) {
      break;
    }
  }
  return unique;
}

function buildFocusPhrase(keywords: string[]): string {
  if (keywords.length === 0) {
    return "the user request";
  }
  if (keywords.length === 1) {
    return keywords[0];
  }
  return `${keywords[0]} + ${keywords[1]}`;
}

function baseCandidates(prompt: string): Array<Omit<PlanCandidate, "id">> {
  const keywords = extractPromptKeywords(prompt);
  const focus = buildFocusPhrase(keywords);
  return [
    {
      title: "Trace-first implementation",
      strategy: "trace-first",
      steps: [
        `Trace the planner/runtime path touching ${focus} and confirm current behavior.`,
        "Identify the smallest insertion point for candidate-plan search before execution.",
        "Implement an opt-in plan-search pass that keeps default runtime behavior unchanged.",
        "Run focused tests around selection logic and the fallback path.",
        "Persist selected/considered plan metadata in run meta and planner events.",
      ],
    },
    {
      title: "Safety-first rollout",
      strategy: "safety-first",
      steps: [
        "Document compatibility constraints and define an explicit feature flag boundary.",
        "Generate K candidate plans with bounded templates to keep overhead predictable.",
        "Score candidates cheaply, select the best, and keep deterministic tie-breaking.",
        "Wire selected plan into execution context only when the flag is enabled.",
        "Verify fallback behavior when scoring fails to avoid blocking execution.",
      ],
    },
    {
      title: "Vertical slice MVP",
      strategy: "vertical-slice",
      steps: [
        "Implement a minimal candidate generation pipeline for the current runtime prompt.",
        "Add heuristic scoring that rewards verification, compatibility, and concise plans.",
        "Choose one best plan and prepend it as execution guidance.",
        "Emit planner events and include considered plans in run artifacts metadata.",
        "Add TODO markers only where deeper LLM-based scoring would be added later.",
      ],
    },
    {
      title: "Verification-heavy implementation",
      strategy: "verification-heavy",
      steps: [
        "Map expected behavior for both feature-enabled and legacy runtime paths.",
        "Generate multiple candidate plans emphasizing test/lint and rollback safety.",
        "Run scoring and select the strongest candidate for full execution.",
        "Persist selected/considered metadata for diagnostics and observability.",
        "Run targeted runtime tests plus impacted lint/tests before shipping.",
      ],
    },
    {
      title: "Failure-aware implementation",
      strategy: "failure-aware",
      steps: [
        "Define failure modes for scoring, prompt shaping, and metadata persistence.",
        "Generate K candidates with explicit fallback and backward-compatibility steps.",
        "Use cheap scoring and enforce first-candidate fallback on scorer failure.",
        "Carry plan metadata to run results/events for post-run debugging.",
        "Validate selection behavior and scorer-failure fallback with focused tests.",
      ],
    },
  ];
}

function buildCandidatePlans(prompt: string, count: number): PlanCandidate[] {
  const base = baseCandidates(prompt);
  return Array.from({ length: count }, (_, index) => {
    const template = base[index % base.length];
    const variant = Math.floor(index / base.length);
    const variantLabel = variant > 0 ? ` (variant ${variant + 1})` : "";
    return {
      id: `plan-${index + 1}`,
      title: `${template.title}${variantLabel}`,
      strategy: `${template.strategy}${variantLabel}`,
      steps: template.steps,
    };
  });
}

function scoreCandidateHeuristically(prompt: string, candidate: PlanCandidate): PlanScoreResult {
  const promptKeywords = extractPromptKeywords(prompt);
  const fullText = `${candidate.title} ${candidate.steps.join(" ")}`.toLowerCase();
  const rationale: string[] = [];
  let score = 0;

  const keywordHits = promptKeywords.filter((keyword) => fullText.includes(keyword)).length;
  if (keywordHits > 0) {
    score += Math.min(4, keywordHits) * 1.2;
    rationale.push(`keyword_hits:${keywordHits}`);
  }

  const checks: Array<{ pattern: RegExp; points: number; reason: string }> = [
    { pattern: /\b(test|verify|validate|lint|smoke)\b/, points: 2, reason: "has-validation" },
    {
      pattern: /\b(feature flag|opt-in|toggle)\b/,
      points: 1.5,
      reason: "mentions-feature-flag",
    },
    {
      pattern: /\b(backward compat|backward-compatible|fallback)\b/,
      points: 1.25,
      reason: "mentions-compat-or-fallback",
    },
    {
      pattern: /\b(artifact|event|metadata|persist)\b/,
      points: 1,
      reason: "mentions-artifacts",
    },
    {
      pattern: /\b(minimal|mvp|vertical slice)\b/,
      points: 0.75,
      reason: "mentions-mvp",
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(fullText)) {
      score += check.points;
      rationale.push(check.reason);
    }
  }

  if (candidate.steps.length >= 4 && candidate.steps.length <= 6) {
    score += 1;
    rationale.push("balanced-step-count");
  }

  const avgStepLength =
    candidate.steps.reduce((acc, step) => acc + step.length, 0) /
    Math.max(1, candidate.steps.length);
  if (avgStepLength > 180) {
    score -= 0.5;
    rationale.push("long-step-penalty");
  }

  return {
    score: Number(score.toFixed(3)),
    rationale,
  };
}

function resolveScorer(
  prompt: string,
  mode: PlanSearchRuntimeConfig["scoringMode"],
): PlanCandidateScorer {
  if (mode === "llm") {
    // TODO(wave-2): wire an actual lightweight LLM ranker; fallback stays heuristic for MVP.
    return (candidate) => {
      const base = scoreCandidateHeuristically(prompt, candidate);
      return {
        score: base.score,
        rationale: [...base.rationale, "llm_mode_fell_back_to_heuristic"],
      };
    };
  }
  return (candidate) => scoreCandidateHeuristically(prompt, candidate);
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return `${error}`;
  }
  if (error && typeof error === "object") {
    const record = error as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  }
  return "scoring failed";
}

function buildPromptWithSelectedPlan(prompt: string, selected: ScoredPlanCandidate): string {
  const numberedSteps = selected.steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n");
  return [
    "Selected execution plan (auto-selected before run):",
    `Plan: ${selected.id} — ${selected.title}`,
    `Strategy: ${selected.strategy}`,
    numberedSteps,
    "",
    "Execute this plan pragmatically; adapt if new information appears.",
    "",
    "Original user request:",
    prompt,
  ].join("\n");
}

export function resolvePlanSearchRuntimeConfig(
  config?: OpenClawConfig,
): PlanSearchRuntimeConfig | undefined {
  const raw = config?.agents?.defaults?.planSearch;
  if (!raw?.enabled) {
    return undefined;
  }

  return {
    enabled: true,
    candidateCount: clampCandidateCount(raw.candidates),
    scoringMode: raw.scoring === "llm" ? "llm" : "heuristic",
    includeSelectedPlanInPrompt: raw.includeSelectedPlanInPrompt !== false,
  };
}

export function runPlanSearch(params: {
  prompt: string;
  runtimeConfig: PlanSearchRuntimeConfig;
  scorer?: PlanCandidateScorer;
}): PlanSearchResult {
  const { prompt, runtimeConfig } = params;
  const candidates = buildCandidatePlans(prompt, runtimeConfig.candidateCount);
  const scorer = params.scorer ?? resolveScorer(prompt, runtimeConfig.scoringMode);

  let appliedScoringMode: EmbeddedPiPlanSearchMeta["appliedScoringMode"] =
    runtimeConfig.scoringMode;
  let scored: ScoredPlanCandidate[];
  let scoringFailed = false;
  let scoringError: string | undefined;

  try {
    scored = candidates.map((candidate) => {
      const result = scorer(candidate);
      return {
        ...candidate,
        score: result.score,
        rationale: result.rationale,
      };
    });
  } catch (error) {
    scoringFailed = true;
    scoringError = describeError(error);
    appliedScoringMode = "heuristic";
    scored = candidates.map((candidate, index) => ({
      ...candidate,
      score: index === 0 ? 0 : -index,
      rationale: ["scoring_failed_fallback_to_first_candidate"],
    }));
  }

  const considered = scored.toSorted((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id.localeCompare(b.id);
  });
  const selected = considered[0] ?? {
    ...candidates[0],
    score: 0,
    rationale: ["single_candidate_default"],
  };

  const promptWithPlan = runtimeConfig.includeSelectedPlanInPrompt
    ? buildPromptWithSelectedPlan(prompt, selected)
    : prompt;

  const meta: EmbeddedPiPlanSearchMeta = {
    enabled: true,
    candidateCount: runtimeConfig.candidateCount,
    configuredScoringMode: runtimeConfig.scoringMode,
    appliedScoringMode,
    selectedCandidateId: selected.id,
    selectedScore: selected.score,
    considered: considered.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      strategy: candidate.strategy,
      score: candidate.score,
      rationale: candidate.rationale,
      stepCount: candidate.steps.length,
    })),
    scoringFailed: scoringFailed ? true : undefined,
    scoringError,
  };

  return {
    prompt: promptWithPlan,
    selected,
    considered,
    meta,
  };
}
