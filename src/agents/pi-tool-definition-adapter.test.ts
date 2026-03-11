import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

async function executeTool(tool: AgentTool, callId: string) {
  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
      reliability: {
        attempts: 1,
        retried: false,
        retryable: false,
        classification: "permanent",
      },
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("retries transient thrown tool failures once before succeeding", async () => {
    const transient = new Error("socket hang up");
    (transient as Error & { code?: string }).code = "ECONNRESET";
    const execute = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "ok" }],
        details: { ok: true },
      });
    const tool = {
      name: "browser_open",
      label: "Browser Open",
      description: "retries transient failures",
      parameters: Type.Object({}),
      execute: execute as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call5");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.details).toEqual({ ok: true });
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
  });

  it("returns structured retry metadata when transient failures exhaust retries", async () => {
    const transient = new Error("temporary upstream failure");
    (transient as Error & { status?: number }).status = 503;
    const execute = vi.fn().mockRejectedValue(transient);
    const tool = {
      name: "browser_open",
      label: "Browser Open",
      description: "transient failures keep failing",
      parameters: Type.Object({}),
      execute: execute as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call6");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      status: "error",
      tool: "browser_open",
      error: "temporary upstream failure",
      reliability: {
        attempts: 2,
        retried: true,
        retryable: true,
        classification: "transient",
        status: 503,
      },
    });
  });

  it("does not retry permanent thrown tool failures", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("invalid request"));
    const tool = {
      name: "browser_open",
      label: "Browser Open",
      description: "permanent failure",
      parameters: Type.Object({}),
      execute: execute as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call7");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      status: "error",
      tool: "browser_open",
      reliability: {
        attempts: 1,
        retried: false,
        retryable: false,
        classification: "permanent",
      },
    });
  });
});
