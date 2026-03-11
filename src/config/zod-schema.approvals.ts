import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalCheckpointSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireAtOrAbove: z
      .union([z.literal("low"), z.literal("medium"), z.literal("high"), z.literal("critical")])
      .optional(),
  })
  .strict()
  .optional();

const ExecApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
    checkpoints: ExecApprovalCheckpointSchema,
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
  })
  .strict()
  .optional();
