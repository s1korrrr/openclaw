import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { buildAgentTraceBase, type AgentTraceBase } from "./trace-base.js";

export type AgentLoopTraceStage = "plan" | "tool" | "observation" | "replan";
export type AgentLoopTraceStatus = "completed" | "failed" | "aborted" | "retry";
export type AgentLoopObservationKind =
  | "plan_result"
  | "tool_result"
  | "assistant_response"
  | "assistant_error"
  | "prompt_error"
  | "timeout"
  | "client_tool_call"
  | "evaluation_result";

export type AgentLoopUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type AgentLoopTraceSpan = AgentTraceBase & {
  ts: number;
  seq: number;
  type: "agent.loop.span";
  stage: AgentLoopTraceStage;
  stepId: string;
  stepIndex: number;
  parentStepId?: string;
  attempt?: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  status: AgentLoopTraceStatus;
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  observationKind?: AgentLoopObservationKind;
  usage?: AgentLoopUsage;
  costUsd?: number;
  failureReason?: string;
  stopReason?: string;
  details?: Record<string, unknown>;
};

type AgentLoopTraceStart = {
  stage: AgentLoopTraceStage;
  parentStepId?: string;
  attempt?: number;
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  observationKind?: AgentLoopObservationKind;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  details?: Record<string, unknown>;
};

type AgentLoopTraceFinish = Omit<AgentLoopTraceStart, "stage"> & {
  status: AgentLoopTraceStatus;
  startedAtMs?: number;
  usage?: AgentLoopUsage;
  costUsd?: number;
  failureReason?: string;
  stopReason?: string;
  endedAtMs?: number;
};

type AgentLoopTraceWriter = QueuedFileWriter;

type AgentLoopTraceConfig = {
  enabled: boolean;
  filePath: string;
};

type ActiveSpan = AgentLoopTraceStart & {
  stage: AgentLoopTraceStage;
  stepId: string;
  stepIndex: number;
  startedAtMs: number;
};

type AgentLoopTraceInit = AgentTraceBase & {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  writer?: AgentLoopTraceWriter;
};

const writers = new Map<string, AgentLoopTraceWriter>();
const tracesByRunId = new Map<string, AgentLoopTrace>();

function resolveAgentLoopTraceConfig(params: AgentLoopTraceInit): AgentLoopTraceConfig {
  const env = params.env ?? process.env;
  const config = params.cfg?.diagnostics?.agentLoopTrace;
  const envEnabled = parseBooleanValue(env.OPENCLAW_AGENT_LOOP_TRACE);
  const enabled = envEnabled ?? config?.enabled ?? false;
  const fileOverride = config?.filePath?.trim() || env.OPENCLAW_AGENT_LOOP_TRACE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "agent-loop-trace.jsonl");
  return { enabled, filePath };
}

function getWriter(filePath: string): AgentLoopTraceWriter {
  return getQueuedFileWriter(writers, filePath);
}

export type AgentLoopTrace = {
  enabled: true;
  filePath: string;
  startSpan: (params: AgentLoopTraceStart) => string;
  finishSpan: (stepId: string, params: AgentLoopTraceFinish) => AgentLoopTraceSpan | null;
  recordSpan: (params: AgentLoopTraceStart & AgentLoopTraceFinish) => AgentLoopTraceSpan;
  getCurrentReplanStepId: () => string | undefined;
  getLastReplanStepId: () => string | undefined;
};

export function createAgentLoopTrace(params: AgentLoopTraceInit): AgentLoopTrace | null {
  const cfg = resolveAgentLoopTraceConfig(params);
  if (!cfg.enabled || !params.runId) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  let seq = 0;
  let stepIndex = 0;
  let currentReplanStepId: string | undefined;
  let lastReplanStepId: string | undefined;
  const activeSpans = new Map<string, ActiveSpan>();
  const base = buildAgentTraceBase(params);

  const writeSpan = (span: Omit<AgentLoopTraceSpan, "ts" | "seq" | "type">): AgentLoopTraceSpan => {
    const event: AgentLoopTraceSpan = {
      ...base,
      ...span,
      ts: Date.now(),
      seq: (seq += 1),
      type: "agent.loop.span",
    };
    const line = safeJsonStringify(event);
    if (line) {
      writer.write(`${line}\n`);
    }
    emitDiagnosticEvent({
      type: "agent.loop.span",
      runId: event.runId ?? "",
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      provider: event.provider,
      modelId: event.modelId,
      stage: event.stage,
      stepId: event.stepId,
      stepIndex: event.stepIndex,
      parentStepId: event.parentStepId,
      attempt: event.attempt,
      startedAtMs: event.startedAtMs,
      endedAtMs: event.endedAtMs,
      durationMs: event.durationMs,
      status: event.status,
      reason: event.reason,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      observationKind: event.observationKind,
      usage: event.usage,
      costUsd: event.costUsd,
      failureReason: event.failureReason,
      stopReason: event.stopReason,
      details: event.details,
    });
    return event;
  };

  const nextStep = (stage: AgentLoopTraceStage) => {
    stepIndex += 1;
    return {
      stepIndex,
      stepId: `${stage}-${String(stepIndex).padStart(4, "0")}`,
    };
  };

  const startSpan: AgentLoopTrace["startSpan"] = (span) => {
    const next = nextStep(span.stage);
    const active: ActiveSpan = {
      ...span,
      ...next,
      parentStepId:
        span.parentStepId ?? (span.stage === "tool" ? currentReplanStepId : lastReplanStepId),
      startedAtMs: Date.now(),
    };
    activeSpans.set(active.stepId, active);
    if (active.stage === "replan") {
      currentReplanStepId = active.stepId;
    }
    return active.stepId;
  };

  const finishSpan: AgentLoopTrace["finishSpan"] = (stepId, params) => {
    const active = activeSpans.get(stepId);
    if (!active) {
      return null;
    }
    activeSpans.delete(stepId);
    if (active.stage === "replan") {
      if (currentReplanStepId === stepId) {
        currentReplanStepId = undefined;
      }
      lastReplanStepId = stepId;
    }
    const endedAtMs = params.endedAtMs ?? Date.now();
    return writeSpan({
      stage: active.stage,
      stepId: active.stepId,
      stepIndex: active.stepIndex,
      parentStepId: params.parentStepId ?? active.parentStepId,
      attempt: params.attempt ?? active.attempt,
      startedAtMs: active.startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - active.startedAtMs),
      status: params.status,
      reason: params.reason ?? active.reason,
      toolName: params.toolName ?? active.toolName,
      toolCallId: params.toolCallId ?? active.toolCallId,
      observationKind: params.observationKind ?? active.observationKind,
      usage: params.usage,
      costUsd: params.costUsd,
      failureReason: params.failureReason,
      stopReason: params.stopReason,
      details: params.details ?? active.details,
      provider: params.provider ?? active.provider,
      modelId: params.modelId ?? active.modelId,
      modelApi: params.modelApi ?? active.modelApi,
      runId: base.runId,
      sessionId: base.sessionId,
      sessionKey: base.sessionKey,
      workspaceDir: base.workspaceDir,
    });
  };

  const recordSpan: AgentLoopTrace["recordSpan"] = (span) => {
    const next = nextStep(span.stage);
    const endedAtMs = span.endedAtMs ?? Date.now();
    const startedAtMs = Math.min(span.startedAtMs ?? endedAtMs, endedAtMs);
    return writeSpan({
      stage: span.stage,
      stepId: next.stepId,
      stepIndex: next.stepIndex,
      parentStepId:
        span.parentStepId ??
        (span.stage === "observation"
          ? lastReplanStepId
          : (currentReplanStepId ?? lastReplanStepId)),
      attempt: span.attempt,
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      status: span.status,
      reason: span.reason,
      toolName: span.toolName,
      toolCallId: span.toolCallId,
      observationKind: span.observationKind,
      usage: span.usage,
      costUsd: span.costUsd,
      failureReason: span.failureReason,
      stopReason: span.stopReason,
      details: span.details,
      provider: span.provider,
      modelId: span.modelId,
      modelApi: span.modelApi,
      runId: base.runId,
      sessionId: base.sessionId,
      sessionKey: base.sessionKey,
      workspaceDir: base.workspaceDir,
    });
  };

  return {
    enabled: true,
    filePath: cfg.filePath,
    startSpan,
    finishSpan,
    recordSpan,
    getCurrentReplanStepId: () => currentReplanStepId,
    getLastReplanStepId: () => lastReplanStepId,
  };
}

export function registerAgentLoopTrace(runId: string, trace: AgentLoopTrace | null): void {
  if (!runId) {
    return;
  }
  if (!trace) {
    tracesByRunId.delete(runId);
    return;
  }
  tracesByRunId.set(runId, trace);
}

export function getAgentLoopTrace(runId: string): AgentLoopTrace | undefined {
  return tracesByRunId.get(runId);
}

export function clearAgentLoopTrace(runId: string): void {
  tracesByRunId.delete(runId);
}

export async function readAgentLoopTimeline(params: {
  filePath: string;
  runId?: string;
}): Promise<AgentLoopTraceSpan[]> {
  let raw = "";
  try {
    raw = await fs.readFile(params.filePath, "utf8");
  } catch {
    return [];
  }

  const events = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentLoopTraceSpan)
    .filter((entry) => entry.type === "agent.loop.span")
    .filter((entry) => !params.runId || entry.runId === params.runId)
    .toSorted((left, right) => {
      if (left.stepIndex !== right.stepIndex) {
        return left.stepIndex - right.stepIndex;
      }
      if (left.startedAtMs !== right.startedAtMs) {
        return left.startedAtMs - right.startedAtMs;
      }
      return left.seq - right.seq;
    });

  return events;
}

export function resetAgentLoopTraceForTest(): void {
  tracesByRunId.clear();
  writers.clear();
}
