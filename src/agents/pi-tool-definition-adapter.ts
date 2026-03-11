import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { logDebug, logError, logWarn } from "../logger.js";
import { isPlainObject } from "../utils.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;
type ToolExecutionFailureKind = "abort" | "permanent" | "transient";

const TRANSIENT_TOOL_ERROR_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_TOOL_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const TRANSIENT_TOOL_ERROR_MESSAGE_RE =
  /\b(timeout|timed out|temporary|temporarily|transient|network error|connection reset|socket hang up|rate limit|too many requests|overloaded|unavailable|try again)\b/i;
const NON_RETRYABLE_TOOL_ERROR_NAMES = new Set([
  "AbortError",
  "ToolAuthorizationError",
  "ToolInputError",
]);
const MAX_TOOL_RELIABILITY_ATTEMPTS = 2;
const DEFAULT_TRANSIENT_TOOL_RETRY_MS = 250;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function throwIfExecutionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  const error = new Error("This operation was aborted.");
  error.name = "AbortError";
  throw error;
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function readErrorNumber(err: unknown, keys: string[]): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readErrorString(err: unknown, keys: string[]): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function classifyToolExecutionFailure(err: unknown): {
  kind: ToolExecutionFailureKind;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
} {
  const described = describeToolExecutionError(err);
  const status = readErrorNumber(err, ["status", "statusCode", "httpStatus"]);
  const code = readErrorString(err, ["code", "errno"]);
  const retryAfterMs = readErrorNumber(err, ["retryAfterMs", "retry_after_ms"]);
  const name =
    err && typeof err === "object" && "name" in err && typeof err.name === "string"
      ? err.name
      : undefined;

  if (name && NON_RETRYABLE_TOOL_ERROR_NAMES.has(name)) {
    return {
      kind: name === "AbortError" ? "abort" : "permanent",
      message: described.message,
      stack: described.stack,
      status,
      code,
      retryAfterMs,
    };
  }

  const transient =
    (typeof status === "number" && TRANSIENT_TOOL_ERROR_STATUSES.has(status)) ||
    (typeof code === "string" && TRANSIENT_TOOL_ERROR_CODES.has(code.toUpperCase())) ||
    TRANSIENT_TOOL_ERROR_MESSAGE_RE.test(described.message);

  return {
    kind: transient ? "transient" : "permanent",
    message: described.message,
    stack: described.stack,
    status,
    code,
    retryAfterMs,
  };
}

async function waitForTransientRetry(delayMs: number, signal: AbortSignal | undefined) {
  if (!(delayMs > 0)) {
    return;
  }
  throwIfExecutionAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("This operation was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stringifyToolPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const encoded = JSON.stringify(payload, null, 2);
    if (typeof encoded === "string") {
      return encoded;
    }
  } catch {
    // Fall through to String(payload) for non-serializable values.
  }
  return String(payload);
}

function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return {
      content: [
        {
          type: "text",
          text: stringifyToolPayload(safeDetails),
        },
      ],
      details: safeDetails,
    };
  }
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return {
    content: [
      {
        type: "text",
        text: stringifyToolPayload(safeDetails),
      },
    ],
    details: safeDetails,
  };
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        throwIfExecutionAborted(signal);
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }
          throwIfExecutionAborted(signal);
          for (let attempt = 1; attempt <= MAX_TOOL_RELIABILITY_ATTEMPTS; attempt += 1) {
            try {
              const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
              throwIfExecutionAborted(signal);
              const result = normalizeToolExecutionResult({
                toolName: normalizedName,
                result: rawResult,
              });
              return result;
            } catch (err) {
              if (signal?.aborted) {
                throw err;
              }
              const failure = classifyToolExecutionFailure(err);
              if (failure.kind === "abort") {
                throw err;
              }
              const shouldRetry =
                failure.kind === "transient" && attempt < MAX_TOOL_RELIABILITY_ATTEMPTS;
              if (shouldRetry) {
                const delayMs = failure.retryAfterMs ?? DEFAULT_TRANSIENT_TOOL_RETRY_MS;
                logWarn(
                  `[tools] ${normalizedName} transient failure on attempt ${attempt}/${MAX_TOOL_RELIABILITY_ATTEMPTS}: ${failure.message}; retrying in ${delayMs}ms`,
                );
                await waitForTransientRetry(delayMs, signal);
                continue;
              }
              if (failure.stack && failure.stack !== failure.message) {
                logDebug(`tools: ${normalizedName} failed stack:\n${failure.stack}`);
              }
              logError(
                `[tools] ${normalizedName} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${failure.message}`,
              );

              return jsonResult({
                status: "error",
                tool: normalizedName,
                error: failure.message,
                reliability: {
                  attempts: attempt,
                  retried: attempt > 1,
                  retryable: failure.kind === "transient",
                  classification: failure.kind,
                  retryAfterMs: failure.retryAfterMs,
                  status: failure.status,
                  code: failure.code,
                },
              });
            }
          }
          throw new Error(
            `tool reliability wrapper exhausted without returning: ${normalizedName}`,
          );
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          return jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
            reliability: {
              attempts: 1,
              retried: false,
              retryable: false,
              classification: "permanent",
            },
          });
        }
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, signal } = splitToolExecuteArgs(args);
        throwIfExecutionAborted(signal);
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }
        throwIfExecutionAborted(signal);
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        throwIfExecutionAborted(signal);
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
