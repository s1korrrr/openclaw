import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema brains", () => {
  it("accepts execution mutating-tool allowlists", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        brains: {
          enabled: true,
          execution: {
            mutatingTools: {
              mode: "allowlist",
              allow: ["write", "apply_patch"],
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown mutating-tool modes", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        brains: {
          enabled: true,
          execution: {
            mutatingTools: {
              mode: "sometimes",
            },
          },
        },
      }),
    ).toThrow();
  });
});
