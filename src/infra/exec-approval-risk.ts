import type {
  ExecApprovalCheckpointConfig,
  ExecApprovalRiskTier,
} from "../config/types.approvals.js";
import type { ExecHost, ExecSecurity, SystemRunApprovalPlan } from "./exec-approvals.js";

export type ExecApprovalRiskReason =
  | "node-host"
  | "full-security"
  | "mutable-file-operand"
  | "obfuscated-command";

export type ExecApprovalRiskMetadata = {
  tier: ExecApprovalRiskTier;
  reasons: ExecApprovalRiskReason[];
  checkpointThreshold?: ExecApprovalRiskTier | null;
};

const EXEC_APPROVAL_RISK_ORDER: Record<ExecApprovalRiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const EXEC_APPROVAL_RISK_REASON_LABELS: Record<ExecApprovalRiskReason, string> = {
  "node-host": "node host",
  "full-security": "full security",
  "mutable-file-operand": "mutable file target",
  "obfuscated-command": "obfuscated command",
};

function escalateRiskTier(
  current: ExecApprovalRiskTier,
  next: ExecApprovalRiskTier,
): ExecApprovalRiskTier {
  return EXEC_APPROVAL_RISK_ORDER[next] > EXEC_APPROVAL_RISK_ORDER[current] ? next : current;
}

function pushReason(reasons: ExecApprovalRiskReason[], reason: ExecApprovalRiskReason) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function compareExecApprovalRiskTier(
  left: ExecApprovalRiskTier,
  right: ExecApprovalRiskTier,
): number {
  return EXEC_APPROVAL_RISK_ORDER[left] - EXEC_APPROVAL_RISK_ORDER[right];
}

export function resolveExecApprovalCheckpointThreshold(
  checkpoints?: ExecApprovalCheckpointConfig | null,
): ExecApprovalRiskTier | null {
  if (checkpoints?.enabled !== true) {
    return null;
  }
  return checkpoints.requireAtOrAbove ?? "high";
}

export function classifyExecApprovalRisk(params: {
  host: ExecHost;
  security: ExecSecurity;
  systemRunPlan?: SystemRunApprovalPlan | null;
  obfuscationDetected?: boolean;
}): ExecApprovalRiskMetadata {
  let tier: ExecApprovalRiskTier = params.host === "node" ? "high" : "low";
  const reasons: ExecApprovalRiskReason[] = [];

  if (params.host === "node") {
    pushReason(reasons, "node-host");
  }
  if (params.security === "full") {
    tier = escalateRiskTier(tier, "medium");
    pushReason(reasons, "full-security");
  }
  if (params.systemRunPlan?.mutableFileOperand) {
    tier = escalateRiskTier(tier, "high");
    pushReason(reasons, "mutable-file-operand");
  }
  if (params.obfuscationDetected) {
    tier = escalateRiskTier(tier, "high");
    pushReason(reasons, "obfuscated-command");
  }

  return { tier, reasons };
}

export function shouldRequireExecApprovalCheckpoint(params: {
  risk: Pick<ExecApprovalRiskMetadata, "tier">;
  checkpointThreshold?: ExecApprovalRiskTier | null;
}): boolean {
  const threshold = params.checkpointThreshold ?? null;
  return threshold !== null && compareExecApprovalRiskTier(params.risk.tier, threshold) >= 0;
}

export function withExecApprovalCheckpointMetadata(params: {
  risk: ExecApprovalRiskMetadata;
  checkpointThreshold?: ExecApprovalRiskTier | null;
}): ExecApprovalRiskMetadata {
  return shouldRequireExecApprovalCheckpoint(params)
    ? { ...params.risk, checkpointThreshold: params.checkpointThreshold ?? null }
    : params.risk;
}

export function formatExecApprovalRiskSummary(
  risk?: ExecApprovalRiskMetadata | null,
): string | null {
  if (!risk) {
    return null;
  }
  const details: string[] = [];
  if (risk.checkpointThreshold) {
    details.push(`checkpoint >= ${risk.checkpointThreshold}`);
  }
  if (risk.reasons.length > 0) {
    details.push(
      risk.reasons.map((reason) => EXEC_APPROVAL_RISK_REASON_LABELS[reason] ?? reason).join(", "),
    );
  }
  return details.length > 0 ? `${risk.tier} (${details.join("; ")})` : risk.tier;
}
