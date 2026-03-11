import { describe, expect, it } from "vitest";
import {
  buildCronProceduralPlaybookSignature,
  createInMemoryCronProceduralPlaybookMemoryStoreV0,
  CronProceduralPlaybookMemoryLayerV0,
  recordCronProceduralPlaybookSignalV0,
  resolveCronProceduralPlaybookFailureKind,
} from "./procedural-playbook-memory-v0.js";

describe("resolveCronProceduralPlaybookFailureKind", () => {
  it("classifies known cron failure shapes", () => {
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "delivery target is missing for telegram announce",
      }),
    ).toBe("delivery-target");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "invalid cron.add params: schedule.everyMs required",
      }),
    ).toBe("tool-validation");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "isolated cron jobs require payload.kind=agentTurn",
      }),
    ).toBe("runtime-validation");
    expect(
      resolveCronProceduralPlaybookFailureKind({
        error: "job timed out after 30 seconds",
      }),
    ).toBe("timeout");
  });
});

describe("CronProceduralPlaybookMemoryLayerV0", () => {
  it("records failure entries and builds ranked prompt guidance", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store,
      nowMs: () => 1_700_000_000_000,
    });

    const entry = layer.recordSignal({
      jobId: "job-1",
      jobName: "notify",
      sessionTarget: "main",
      payloadKind: "systemEvent",
      status: "error",
      error: "delivery target is missing",
    });

    expect(entry).toMatchObject({
      signature: buildCronProceduralPlaybookSignature({
        sessionTarget: "main",
        payloadKind: "systemEvent",
        failureKind: "delivery-target",
      }),
      failureKind: "delivery-target",
      failureCount: 1,
      successCount: 0,
      jobIds: ["job-1"],
      safeDefault: true,
    });

    expect(layer.getGuidance()).toEqual([
      expect.objectContaining({
        failureKind: "delivery-target",
        selectionScore: 10,
        unresolvedFailureCount: 1,
        recencyWeight: 1,
        failureCount: 1,
        successCount: 0,
      }),
    ]);
    expect(layer.buildPromptSnippet()).toContain(
      "score 10.00; 1 failures / 0 recoveries / 1 unresolved",
    );
    expect(layer.getHypotheses()).toEqual([
      expect.objectContaining({
        failureKind: "delivery-target",
        category: "delivery_target_resolution",
        title: "Test explicit deterministic delivery routing",
        selectionScore: 10,
        confidence: 0.67,
      }),
    ]);
    expect(layer.buildPromptSnippet()).toContain("Hypothesis candidates from repeated failures:");
  });

  it("records recoveries against the prior failure signature", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store,
      nowMs: () => 1_700_000_000_000,
    });

    layer.recordSignal({
      jobId: "job-1",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "error",
      error: "invalid cron.add params: payload.message required",
    });

    const recovered = layer.recordSignal({
      jobId: "job-1",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "ok",
      error: "invalid cron.add params: payload.message required",
    });

    expect(recovered).toMatchObject({
      failureKind: "tool-validation",
      failureCount: 1,
      successCount: 1,
      jobIds: ["job-1"],
    });
  });

  it("prefers recent unresolved failures over older recovered playbooks", () => {
    const nowMs = 1_700_000_000_000;
    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store,
      nowMs: () => nowMs,
    });

    for (let index = 0; index < 4; index += 1) {
      layer.recordSignal({
        jobId: `delivery-fail-${index}`,
        sessionTarget: "main",
        payloadKind: "systemEvent",
        status: "error",
        error: "delivery target is missing",
        occurredAtMs: nowMs - twoWeeksMs,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      layer.recordSignal({
        jobId: `delivery-ok-${index}`,
        sessionTarget: "main",
        payloadKind: "systemEvent",
        status: "ok",
        error: "delivery target is missing",
        occurredAtMs: nowMs - twoWeeksMs + 1_000,
      });
    }

    layer.recordSignal({
      jobId: "tool-fail-1",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "error",
      error: "invalid cron.add params: payload.message required",
      occurredAtMs: nowMs,
    });
    layer.recordSignal({
      jobId: "tool-fail-2",
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      status: "error",
      error: "invalid cron.add params: payload.message required",
      occurredAtMs: nowMs,
    });

    const guidance = layer.getGuidance({ includeUnknown: true, limit: 2 });

    expect(guidance.map((entry) => entry.failureKind)).toEqual([
      "tool-validation",
      "delivery-target",
    ]);
    expect(guidance[0]).toMatchObject({
      failureKind: "tool-validation",
      unresolvedFailureCount: 2,
      selectionScore: 20,
      recencyWeight: 1,
    });
    expect(guidance[1]).toMatchObject({
      failureKind: "delivery-target",
      unresolvedFailureCount: 1,
    });
    expect(guidance[1]?.selectionScore).toBeCloseTo(2.33333, 5);
    expect(guidance[1]?.recencyWeight).toBeCloseTo(0.33333, 5);

    const hypotheses = layer.getHypotheses({ includeUnknown: true, limit: 2 });
    expect(hypotheses.map((entry) => entry.failureKind)).toEqual([
      "tool-validation",
      "delivery-target",
    ]);
    expect(hypotheses[0]).toMatchObject({
      category: "tool_input_prevalidation",
    });
    expect(hypotheses[0]?.confidence).toBeGreaterThan(hypotheses[1]?.confidence ?? 0);
  });
});

describe("recordCronProceduralPlaybookSignalV0", () => {
  it("returns undefined when disabled", () => {
    const store = createInMemoryCronProceduralPlaybookMemoryStoreV0();

    const result = recordCronProceduralPlaybookSignalV0({
      enabled: false,
      store,
      signal: {
        jobId: "job-1",
        sessionTarget: "main",
        payloadKind: "systemEvent",
        status: "error",
        error: "delivery target is missing",
      },
    });

    expect(result).toBeUndefined();
  });
});
