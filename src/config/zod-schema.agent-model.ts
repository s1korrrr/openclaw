import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      routingPolicy: z.union([z.literal("configured"), z.literal("lowest-cost")]).optional(),
    })
    .strict(),
]);
