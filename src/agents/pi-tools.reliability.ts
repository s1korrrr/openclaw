import { sleepWithAbort } from "../infra/backoff.js";
import { extractErrorCode, formatErrorMessage, readErrorName } from "../infra/errors.js";
import { logDebug, logWarn } from "../logger.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

const TOOL_RELIABILITY_MAX_ATTEMPTS = 2;
const TOOL_RELIABILITY_RETRY_DELAY_MS = 150;

const RETRYABLE_ERROR_CODES = new Set([
  "408",
  "425",
  "429",
  "500",
  "502",
  "503",
  "504",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

const RETRYABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const RETRY_BLOCK_MESSAGE_SNIPPETS = [
  "do not retry",
  "don't retry",
  "already exists",
  "duplicate request",
];

const RATE_LIMIT_MESSAGE_SNIPPETS = [
  "rate limit",
  "rate limited",
  "too many requests",
  "retry_after",
];

const TIMEOUT_MESSAGE_SNIPPETS = ["timeout", "timed out", "deadline exceeded"];

const NETWORK_MESSAGE_SNIPPETS = [
  "socket hang up",
  "connection reset",
  "connection refused",
  "network error",
  "network request failed",
  "fetch failed",
  "temporarily unavailable",
  "temporary failure",
  "service unavailable",
  "try again later",
];

export type ToolExecutionFailureClassification =
  | "timeout"
  | "rate_limit"
  | "network"
  | "temporary"
  | "input"
  | "permission"
  | "auth"
  | "permanent"
  | "unknown";

export type ToolExecutionReliabilityMetadata = {
  classification: ToolExecutionFailureClassification;
  retryable: boolean;
  transient: boolean;
  attemptCount: number;
  maxAttempts: number;
  mutatingAction: boolean;
  errorCode?: string;
  errorName?: string;
};

export class ToolExecutionReliabilityError extends Error {
  readonly reliability: ToolExecutionReliabilityMetadata;

  constructor(message: string, reliability: ToolExecutionReliabilityMetadata, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ToolExecutionReliabilityError";
    this.reliability = reliability;
  }
}

function normalizeErrorCode(err: unknown): string | undefined {
  const code = extractErrorCode(err);
  if (!code) {
    return undefined;
  }
  return code.trim().toUpperCase() || undefined;
}

function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  if (typeof status === "string" && status.trim()) {
    const parsed = Number(status);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function getToolExecutionReliabilityMetadata(
  err: unknown,
): ToolExecutionReliabilityMetadata | undefined {
  if (!(err instanceof ToolExecutionReliabilityError)) {
    return undefined;
  }
  return err.reliability;
}

export function classifyToolExecutionFailure(err: unknown): {
  classification: ToolExecutionFailureClassification;
  retryable: boolean;
  transient: boolean;
  errorCode?: string;
  errorName?: string;
} {
  const errorCode = normalizeErrorCode(err);
  const errorName = readErrorName(err) || undefined;
  const statusCode = extractStatusCode(err);
  const message = formatErrorMessage(err).trim().toLowerCase();

  if (message && RETRY_BLOCK_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
    return {
      classification: "permanent",
      retryable: false,
      transient: false,
      errorCode,
      errorName,
    };
  }

  if (statusCode === 401 || statusCode === 403 || message.includes("unauthorized")) {
    return {
      classification: statusCode === 403 || message.includes("forbidden") ? "permission" : "auth",
      retryable: false,
      transient: false,
      errorCode,
      errorName,
    };
  }

  if (
    errorName === "ToolInputError" ||
    statusCode === 400 ||
    statusCode === 404 ||
    message.includes("required") ||
    message.includes("missing") ||
    message.includes("invalid") ||
    message.includes("not found")
  ) {
    return {
      classification: "input",
      retryable: false,
      transient: false,
      errorCode,
      errorName,
    };
  }

  if (
    statusCode === 429 ||
    errorCode === "429" ||
    (message && RATE_LIMIT_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet)))
  ) {
    return {
      classification: "rate_limit",
      retryable: true,
      transient: true,
      errorCode,
      errorName,
    };
  }

  if (
    (errorName && RETRYABLE_ERROR_NAMES.has(errorName)) ||
    statusCode === 408 ||
    statusCode === 504 ||
    (message && TIMEOUT_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet)))
  ) {
    return {
      classification: "timeout",
      retryable: true,
      transient: true,
      errorCode,
      errorName,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      classification: "temporary",
      retryable: true,
      transient: true,
      errorCode,
      errorName,
    };
  }

  if (
    (errorCode && RETRYABLE_ERROR_CODES.has(errorCode)) ||
    (message && NETWORK_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet)))
  ) {
    return {
      classification: "network",
      retryable: true,
      transient: true,
      errorCode,
      errorName,
    };
  }

  if (statusCode === 401 || message.includes("authentication") || message.includes("api key")) {
    return {
      classification: "auth",
      retryable: false,
      transient: false,
      errorCode,
      errorName,
    };
  }

  if (
    statusCode === 403 ||
    message.includes("forbidden") ||
    message.includes("permission denied")
  ) {
    return {
      classification: "permission",
      retryable: false,
      transient: false,
      errorCode,
      errorName,
    };
  }

  return {
    classification: "unknown",
    retryable: false,
    transient: false,
    errorCode,
    errorName,
  };
}

export function wrapToolWithReliability(tool: AnyAgentTool): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const normalizedToolName = normalizeToolName(tool.name || "tool");
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const mutation = buildToolMutationState(normalizedToolName, params);
      const maxAttempts = mutation.mutatingAction ? 1 : TOOL_RELIABILITY_MAX_ATTEMPTS;
      let lastFailure:
        | (ToolExecutionReliabilityMetadata & {
            message: string;
          })
        | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await execute(toolCallId, params, signal, onUpdate);
          if (attempt > 1 && lastFailure) {
            logWarn(
              `tools-reliability: tool=${normalizedToolName} toolCallId=${toolCallId} ` +
                `recovered attempts=${attempt}/${maxAttempts} ` +
                `classification=${lastFailure.classification}`,
            );
          }
          return result;
        } catch (err) {
          if (signal?.aborted || readErrorName(err) === "AbortError") {
            throw err;
          }
          const message = formatErrorMessage(err);
          const classified = classifyToolExecutionFailure(err);
          const reliability: ToolExecutionReliabilityMetadata = {
            ...classified,
            attemptCount: attempt,
            maxAttempts,
            mutatingAction: mutation.mutatingAction,
          };
          lastFailure = { ...reliability, message };
          const logPrefix =
            `tools-reliability: tool=${normalizedToolName} toolCallId=${toolCallId} ` +
            `attempt=${attempt}/${maxAttempts} classification=${reliability.classification} ` +
            `retryable=${reliability.retryable} transient=${reliability.transient} ` +
            `mutating=${reliability.mutatingAction}`;

          if (reliability.retryable && attempt < maxAttempts) {
            logWarn(`${logPrefix} retrying after ${TOOL_RELIABILITY_RETRY_DELAY_MS}ms: ${message}`);
            await sleepWithAbort(TOOL_RELIABILITY_RETRY_DELAY_MS, signal);
            continue;
          }

          if (reliability.retryable && reliability.mutatingAction) {
            logWarn(`${logPrefix} retry skipped for mutating tool: ${message}`);
          } else {
            logDebug(`${logPrefix} giving up: ${message}`);
          }

          throw new ToolExecutionReliabilityError(message, reliability, err);
        }
      }

      throw new ToolExecutionReliabilityError(
        lastFailure?.message ?? `${normalizedToolName} tool execution failed`,
        {
          classification: lastFailure?.classification ?? "unknown",
          retryable: lastFailure?.retryable ?? false,
          transient: lastFailure?.transient ?? false,
          attemptCount: lastFailure?.attemptCount ?? 1,
          maxAttempts: lastFailure?.maxAttempts ?? maxAttempts,
          mutatingAction: lastFailure?.mutatingAction ?? mutation.mutatingAction,
          errorCode: lastFailure?.errorCode,
          errorName: lastFailure?.errorName,
        },
      );
    },
  };
}
