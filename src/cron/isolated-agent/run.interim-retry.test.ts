import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  countActiveDescendantRunsMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  pickLastNonEmptyTextFromPayloadsMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — interim ack retry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  const mockFallbackPassthrough = () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  };

  const runTurnAndExpectOk = async (expectedFallbackCalls: number, expectedAgentCalls: number) => {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(expectedFallbackCalls);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(expectedAgentCalls);
    return result;
  };

  const usePayloadTextExtraction = () => {
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) => {
        for (let idx = (payloads?.length ?? 0) - 1; idx >= 0; idx -= 1) {
          const text = payloads?.[idx]?.text;
          if (typeof text === "string" && text.trim()) {
            return text;
          }
        }
        return "";
      },
    );
  };

  it("regression, retries once when cron returns interim acknowledgement and no descendants were spawned", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
          },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockFallbackPassthrough();
    await runTurnAndExpectOk(2, 2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]?.prompt).toContain(
      "previous response was only an acknowledgement",
    );
  });

  it("does not retry when the first turn is already a concrete result", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("does not retry when descendants were spawned in this run even if they already settled", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "On it, I spawned a subagent and it will auto-announce when done." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    listDescendantRunsForRequesterMock.mockReturnValue([
      {
        startedAt: Date.now() + 60_000,
      },
    ]);
    countActiveDescendantRunsMock.mockReturnValue(0);

    mockFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("records task-graph telemetry for descendants spawned during the run", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Parallel research lanes completed." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    listDescendantRunsForRequesterMock.mockReturnValue([
      {
        runId: "run-beta",
        childSessionKey: "agent:main:subagent:beta",
        model: "gpt-5-mini",
        spawnMode: "session",
        createdAt: Date.now() + 60_000,
        startedAt: Date.now() + 60_000,
        endedAt: Date.now() + 90_000,
        endedReason: "complete",
        outcome: { status: "ok" },
      },
      {
        runId: "run-alpha",
        childSessionKey: "agent:main:subagent:alpha",
        model: "gpt-5-mini",
        spawnMode: "run",
        createdAt: Date.now() + 30_000,
        startedAt: Date.now() + 30_000,
        outcome: { status: "unknown" },
      },
    ]);

    mockFallbackPassthrough();
    const result = await runTurnAndExpectOk(1, 1);

    expect(result.taskGraph).toMatchObject({
      version: 1,
      orchestration: "subagent_fanout_join_v1",
      joinStrategy: "wait_for_descendants",
      laneCount: 2,
      activeLaneCount: 1,
    });
    expect(result.taskGraph?.lanes.map((lane) => lane.runId)).toEqual(["run-alpha", "run-beta"]);
    expect(result.taskGraph?.lanes.map((lane) => lane.status)).toEqual(["running", "completed"]);
  });
});
