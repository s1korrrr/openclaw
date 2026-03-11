import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resolveUserPath } from "../utils.js";
import {
  createAgentLoopTrace,
  readAgentLoopTimeline,
  resetAgentLoopTraceForTest,
} from "./agent-loop-trace.js";

const tempPaths: string[] = [];

afterEach(async () => {
  resetDiagnosticEventsForTest();
  resetAgentLoopTraceForTest();
  await Promise.all(
    tempPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe("agent-loop trace", () => {
  it("returns null when diagnostics agent-loop tracing is disabled", () => {
    const trace = createAgentLoopTrace({
      cfg: {},
      env: {},
      runId: "run-disabled",
    });

    expect(trace).toBeNull();
  });

  it("records spans and emits matching diagnostic events", () => {
    const lines: string[] = [];
    const events: Array<{ type?: string; stage?: string; stepId?: string }> = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "agent.loop.span") {
        events.push(evt);
      }
    });

    const trace = createAgentLoopTrace({
      cfg: {
        diagnostics: {
          agentLoopTrace: {
            enabled: true,
            filePath: "~/.openclaw/logs/agent-loop-trace.jsonl",
          },
        },
      },
      env: {},
      runId: "run-trace",
      sessionId: "session-1",
      sessionKey: "agent:test:1",
      provider: "openai",
      modelId: "gpt-test",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(trace).not.toBeNull();
    expect(trace?.filePath).toBe(resolveUserPath("~/.openclaw/logs/agent-loop-trace.jsonl"));

    const replanStepId =
      trace?.startSpan({
        stage: "replan",
        attempt: 1,
        reason: "initial_prompt",
      }) ?? "";
    trace?.finishSpan(replanStepId, {
      status: "completed",
      attempt: 1,
      usage: { input: 12, output: 8, total: 20 },
      costUsd: 0.0012,
      stopReason: "stop",
    });
    trace?.recordSpan({
      stage: "observation",
      attempt: 1,
      status: "completed",
      observationKind: "assistant_response",
      parentStepId: replanStepId,
      usage: { input: 12, output: 8, total: 20 },
      costUsd: 0.0012,
      details: { toolCount: 0 },
    });

    stop();

    expect(lines).toHaveLength(2);
    const replan = JSON.parse(lines[0] ?? "{}") as {
      stage?: string;
      status?: string;
      stepId?: string;
    };
    const observation = JSON.parse(lines[1] ?? "{}") as {
      stage?: string;
      parentStepId?: string;
      observationKind?: string;
    };
    expect(replan.stage).toBe("replan");
    expect(replan.status).toBe("completed");
    expect(observation.stage).toBe("observation");
    expect(observation.parentStepId).toBe(replan.stepId);
    expect(observation.observationKind).toBe("assistant_response");

    expect(events).toHaveLength(2);
    expect(events[0]?.stage).toBe("replan");
    expect(events[1]?.stage).toBe("observation");
  });

  it("loads a filtered run timeline from jsonl output", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-trace-"));
    tempPaths.push(tempDir);
    const filePath = path.join(tempDir, "agent-loop-trace.jsonl");
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: "agent.loop.span",
          runId: "run-2",
          stage: "replan",
          stepId: "replan-0002",
          stepIndex: 2,
          startedAtMs: 20,
          endedAtMs: 40,
          durationMs: 20,
          status: "completed",
          ts: 40,
          seq: 2,
        }),
        JSON.stringify({
          type: "agent.loop.span",
          runId: "run-1",
          stage: "plan",
          stepId: "plan-0001",
          stepIndex: 1,
          startedAtMs: 5,
          endedAtMs: 10,
          durationMs: 5,
          status: "completed",
          ts: 10,
          seq: 1,
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const timeline = await readAgentLoopTimeline({ filePath, runId: "run-1" });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.stepId).toBe("plan-0001");
  });
});
