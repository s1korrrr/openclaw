import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  applyExecutionBrainMutatingToolGuard,
  resolveEmbeddedPiBrainsRuntimeConfig,
} from "./brains.js";

function tool(name: string): AnyAgentTool {
  return { name } as AnyAgentTool;
}

describe("resolveEmbeddedPiBrainsRuntimeConfig", () => {
  it("returns undefined when the brain split is disabled", () => {
    expect(
      resolveEmbeddedPiBrainsRuntimeConfig({
        config: {
          agents: {
            defaults: {
              brains: {
                enabled: false,
              },
            },
          },
        } satisfies OpenClawConfig,
        agentId: "main",
        researchPhase: "plan_search",
      }),
    ).toBeUndefined();
  });

  it("merges defaults with per-agent mutating-tool overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          brains: {
            enabled: true,
            execution: {
              mutatingTools: {
                mode: "allowlist",
                allow: ["write", "exec"],
              },
            },
          },
        },
        list: [
          {
            id: "main",
            brains: {
              execution: {
                mutatingTools: {
                  allow: ["apply_patch", "WRITE"],
                },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveEmbeddedPiBrainsRuntimeConfig({
        config: cfg,
        agentId: "main",
        researchPhase: "plan_search",
      }),
    ).toEqual({
      enabled: true,
      researchPhase: "plan_search",
      execution: {
        mutatingTools: {
          mode: "allowlist",
          allow: ["apply_patch", "write"],
        },
      },
    });
  });
});

describe("applyExecutionBrainMutatingToolGuard", () => {
  it("filters mutating built-in and client tools while preserving read-only tools", () => {
    const runtime = resolveEmbeddedPiBrainsRuntimeConfig({
      config: {
        agents: {
          defaults: {
            brains: {
              enabled: true,
              execution: {
                mutatingTools: {
                  mode: "allowlist",
                  allow: ["write", "sessions_send"],
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      researchPhase: "plan_search",
    });

    const result = applyExecutionBrainMutatingToolGuard({
      runtime,
      tools: [tool("read"), tool("write"), tool("exec"), tool("session_status")],
      clientTools: [
        {
          type: "function",
          function: { name: "web_search" },
        },
        {
          type: "function",
          function: { name: "sessions_send" },
        },
        {
          type: "function",
          function: { name: "gateway" },
        },
      ],
    });

    expect(result.tools.map((entry) => entry.name)).toEqual(["read", "write"]);
    expect(result.clientTools?.map((entry) => entry.function.name)).toEqual([
      "web_search",
      "sessions_send",
    ]);
    expect(result.meta).toEqual({
      enabled: true,
      research: {
        phase: "plan_search",
      },
      execution: {
        mutatingTools: {
          mode: "allowlist",
          active: true,
          configuredAllow: ["write", "sessions_send"],
          available: ["exec", "gateway", "session_status", "sessions_send", "write"],
          allowed: ["sessions_send", "write"],
          blocked: ["exec", "gateway", "session_status"],
        },
      },
    });
  });

  it("drops all mutating tools in deny_all mode", () => {
    const result = applyExecutionBrainMutatingToolGuard({
      runtime: {
        enabled: true,
        researchPhase: "direct_prompt",
        execution: {
          mutatingTools: {
            mode: "deny_all",
            allow: [],
          },
        },
      },
      tools: [tool("read"), tool("exec"), tool("write")],
    });

    expect(result.tools.map((entry) => entry.name)).toEqual(["read"]);
    expect(result.meta?.execution.mutatingTools.blocked).toEqual(["exec", "write"]);
    expect(result.meta?.research.phase).toBe("direct_prompt");
  });
});
