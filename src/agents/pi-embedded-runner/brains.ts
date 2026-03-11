import type { OpenClawConfig } from "../../config/config.js";
import type {
  AgentBrainsConfig,
  AgentBrainsMutatingToolsConfig,
} from "../../config/types.agent-defaults.js";
import { resolveAgentConfig } from "../agent-scope.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { isLikelyMutatingToolName } from "../tool-mutation.js";
import { normalizeToolName } from "../tool-policy.js";
import type { ClientToolDefinition } from "./run/params.js";
import type { EmbeddedPiBrainsMeta } from "./types.js";

export type EmbeddedPiResearchPhase = "plan_search" | "direct_prompt";
export type EmbeddedPiExecutionMutatingToolsMode = "allow_all" | "deny_all" | "allowlist";

export type EmbeddedPiBrainsRuntimeConfig = {
  enabled: true;
  researchPhase: EmbeddedPiResearchPhase;
  execution: {
    mutatingTools: {
      mode: EmbeddedPiExecutionMutatingToolsMode;
      allow: string[];
    };
  };
};

function normalizeConfiguredToolName(value: string): string {
  return normalizeToolName(value).toLowerCase();
}

function normalizeConfiguredToolList(values: string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") {
      continue;
    }
    const toolName = normalizeConfiguredToolName(value);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    normalized.push(toolName);
  }
  return normalized;
}

function getMutatingToolConfig(
  config: AgentBrainsConfig | undefined,
): AgentBrainsMutatingToolsConfig | undefined {
  return config?.execution?.mutatingTools;
}

export function resolveEmbeddedPiBrainsRuntimeConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  researchPhase: EmbeddedPiResearchPhase;
}): EmbeddedPiBrainsRuntimeConfig | undefined {
  const defaults = params.config?.agents?.defaults?.brains;
  const agent = params.agentId
    ? resolveAgentConfig(params.config ?? {}, params.agentId)?.brains
    : undefined;
  const enabled = agent?.enabled ?? defaults?.enabled ?? false;
  if (!enabled) {
    return undefined;
  }

  const defaultMutatingTools = getMutatingToolConfig(defaults);
  const agentMutatingTools = getMutatingToolConfig(agent);
  const allow =
    agentMutatingTools?.allow !== undefined
      ? normalizeConfiguredToolList(agentMutatingTools.allow)
      : normalizeConfiguredToolList(defaultMutatingTools?.allow);

  return {
    enabled: true,
    researchPhase: params.researchPhase,
    execution: {
      mutatingTools: {
        mode: agentMutatingTools?.mode ?? defaultMutatingTools?.mode ?? "deny_all",
        allow,
      },
    },
  };
}

function shouldKeepMutatingTool(
  toolName: string,
  runtime: EmbeddedPiBrainsRuntimeConfig,
  allowSet: ReadonlySet<string>,
): boolean {
  const mode = runtime.execution.mutatingTools.mode;
  if (mode === "allow_all") {
    return true;
  }
  if (mode === "deny_all") {
    return false;
  }
  return allowSet.has(normalizeConfiguredToolName(toolName));
}

function collectSortedUnique(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    unique.add(trimmed);
  }
  return [...unique].toSorted((left, right) => left.localeCompare(right));
}

function summarizeMutatingToolNames(params: {
  names: string[];
  runtime: EmbeddedPiBrainsRuntimeConfig;
  allowSet: ReadonlySet<string>;
}): Pick<EmbeddedPiBrainsMeta["execution"]["mutatingTools"], "available" | "allowed" | "blocked"> {
  const available = collectSortedUnique(params.names);
  const allowed = collectSortedUnique(
    params.names.filter((name) => shouldKeepMutatingTool(name, params.runtime, params.allowSet)),
  );
  const blocked = collectSortedUnique(
    params.names.filter((name) => !shouldKeepMutatingTool(name, params.runtime, params.allowSet)),
  );
  return { available, allowed, blocked };
}

export function applyExecutionBrainMutatingToolGuard(params: {
  tools: AnyAgentTool[];
  clientTools?: ClientToolDefinition[];
  runtime?: EmbeddedPiBrainsRuntimeConfig;
}): {
  tools: AnyAgentTool[];
  clientTools?: ClientToolDefinition[];
  meta?: EmbeddedPiBrainsMeta;
} {
  const runtime = params.runtime;
  if (!runtime) {
    return {
      tools: params.tools,
      clientTools: params.clientTools,
    };
  }

  const allowSet = new Set(runtime.execution.mutatingTools.allow);
  const mutatingNames = [
    ...params.tools
      .map((tool) => tool.name)
      .filter((name) => typeof name === "string" && isLikelyMutatingToolName(name)),
    ...(params.clientTools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === "string" && isLikelyMutatingToolName(name)),
  ];

  const tools = params.tools.filter(
    (tool) =>
      !isLikelyMutatingToolName(tool.name) || shouldKeepMutatingTool(tool.name, runtime, allowSet),
  );
  const clientTools = params.clientTools?.filter((tool) => {
    const name = tool.function?.name;
    return typeof name !== "string" || !isLikelyMutatingToolName(name)
      ? true
      : shouldKeepMutatingTool(name, runtime, allowSet);
  });
  const summary = summarizeMutatingToolNames({
    names: mutatingNames,
    runtime,
    allowSet,
  });

  return {
    tools,
    clientTools,
    meta: {
      enabled: true,
      research: {
        phase: runtime.researchPhase,
      },
      execution: {
        mutatingTools: {
          mode: runtime.execution.mutatingTools.mode,
          active: runtime.execution.mutatingTools.mode !== "allow_all",
          configuredAllow: [...runtime.execution.mutatingTools.allow],
          available: summary.available,
          allowed: summary.allowed,
          blocked: summary.blocked,
        },
      },
    },
  };
}
