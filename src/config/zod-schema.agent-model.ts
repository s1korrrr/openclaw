import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      fallbackOrdering: z.enum(["configured", "lowest-cost"]).optional(),
    })
    .strict(),
]);
