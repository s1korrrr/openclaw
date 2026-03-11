import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolWithReliability } from "./pi-tools.reliability.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function getWrappedDefinition(tool: AnyAgentTool) {
  const [definition] = toToolDefinitions([wrapToolWithReliability(tool)]);
  if (!definition) {
    throw new Error("missing tool definition");
  }
  return definition;
}

function createStandardResult(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `${toolName}:ok` }],
    details: { tool: toolName, ok: true },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wrapToolWithReliability", () => {
  it("retries transient non-mutating tool failures and preserves successful results", async () => {
    vi.useFakeTimers();
    const success = createStandardResult("read");
    const execute = vi
      .fn<AgentTool["execute"]>()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(success);
    const definition = getWrappedDefinition({
      name: "read",
      label: "Read",
      description: "reads",
      parameters: Type.Object({ path: Type.String() }),
      execute,
    } satisfies AnyAgentTool);

    const resultPromise = definition.execute(
      "call-read",
      { path: "/tmp/demo.txt" },
      undefined,
      undefined,
      extensionContext,
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(result).toEqual(success);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry transient failures for mutating tools and records reliability metadata", async () => {
    const execute = vi.fn<AgentTool["execute"]>().mockRejectedValue(new Error("connect timeout"));
    const definition = getWrappedDefinition({
      name: "exec",
      label: "Exec",
      description: "runs commands",
      parameters: Type.Object({ command: Type.String() }),
      execute,
    } satisfies AnyAgentTool);

    const result = await definition.execute(
      "call-exec",
      { command: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "connect timeout",
      reliability: {
        classification: "timeout",
        retryable: true,
        transient: true,
        attemptCount: 1,
        maxAttempts: 1,
        mutatingAction: true,
      },
    });
  });

  it("honors explicit do-not-retry signals for non-mutating tools", async () => {
    const execute = vi
      .fn<AgentTool["execute"]>()
      .mockRejectedValue(
        new Error("Browser service rate limit reached. Do NOT retry the browser tool."),
      );
    const definition = getWrappedDefinition({
      name: "read",
      label: "Read",
      description: "reads",
      parameters: Type.Object({ path: Type.String() }),
      execute,
    } satisfies AnyAgentTool);

    const result = await definition.execute(
      "call-read-no-retry",
      { path: "/tmp/demo.txt" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      status: "error",
      tool: "read",
      reliability: {
        classification: "permanent",
        retryable: false,
        transient: false,
        attemptCount: 1,
        maxAttempts: 2,
        mutatingAction: false,
      },
    });
  });
});
