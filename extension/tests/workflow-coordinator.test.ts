import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { DEFAULT_WORKFLOW_STATE, getWorkflowState, setWorkflowState } from "../src/background/storage.js";
import { WORKFLOW_ALARM_NAME, WorkflowCoordinator } from "../src/background/workflow-coordinator.js";
import type { ExtensionConfig } from "../src/shared/types.js";

const config: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x" + "ab".repeat(20)],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.01,
  gasPriceJitterPercent: 0,
  dryRun: true,
  cooldownSeconds: 0,
  memoryApiCooldownSeconds: 1,
  predictionReadCooldownSeconds: 2,
  rateLimitBackoffMinutes: 15,
  stopAtRemaining: 0,
  agentId: 900,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

function coordinator(overrides: Partial<ConstructorParameters<typeof WorkflowCoordinator>[0]> = {}) {
  const calls: string[] = [];
  const value = new WorkflowCoordinator({
    getConfig: async () => config,
    getState: getWorkflowState,
    setState: setWorkflowState,
    runFeed: async () => { calls.push("feed"); return { kind: "completed" }; },
    runPredictions: async (_target, scan) => { calls.push(`predictions:${scan}`); return { kind: "completed" }; },
    now: () => 1_000,
    ...overrides,
  });
  return { value, calls };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("WorkflowCoordinator", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("runs Both as Feed then Predictions and schedules the next cycle", async () => {
    const setup = coordinator();

    await setup.value.start("both");
    await setup.value.idle();

    expect(setup.calls).toEqual(["feed", "predictions:full"]);
    expect((await getWorkflowState()).nextRunAt).toBe(7_201_000);
    expect(await chrome.alarms.get("workflow-cycle")).toMatchObject({ scheduledTime: 7_201_000 });
  });

  it("does not run Predictions after a global Feed failure", async () => {
    const setup = coordinator({
      runFeed: async () => ({ kind: "failed", reason: "auth", global: true }),
    });

    await setup.value.start("both");
    await setup.value.idle();

    expect((await getWorkflowState()).status).toBe("paused");
    expect(setup.calls).toEqual([]);
  });

  it("pauses with the thrown runner error instead of rejecting the cycle", async () => {
    const setup = coordinator({
      runFeed: async () => {
        throw new Error("SIWE unavailable");
      },
    });

    await setup.value.start("feed");
    await expect(setup.value.idle()).resolves.toBeUndefined();

    expect(await getWorkflowState()).toMatchObject({
      status: "paused",
      activeWorkflow: null,
      nextRunAt: null,
      lastError: "SIWE unavailable",
    });
  });

  it("pause clears the next alarm and persists paused", async () => {
    const setup = coordinator();
    await setup.value.start("feed");
    await setup.value.idle();

    await setup.value.pause();

    expect((await getWorkflowState()).status).toBe("paused");
    expect(await chrome.alarms.get("workflow-cycle")).toBeUndefined();
  });

  it("schedules a long backoff after predictions rate limits", async () => {
    const setup = coordinator({
      runPredictions: async () => ({ kind: "rate_limited", retryAfterMs: 900_000 }),
      now: () => 1_000_000,
    });

    await setup.value.start("predictions");
    await setup.value.idle();

    expect(await getWorkflowState()).toMatchObject({
      status: "running",
      activeWorkflow: null,
      nextRunAt: 1_900_000,
    });
    expect(await chrome.alarms.get(WORKFLOW_ALARM_NAME)).toMatchObject({
      scheduledTime: 1_900_000,
    });
  });

  it("uses prediction scan start as the full scan interval anchor", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const calls: string[] = [];
    await setWorkflowState({
      ...structuredClone(DEFAULT_WORKFLOW_STATE),
      status: "running",
      mode: "predictions",
      predictionScanStartedAt: 10_000,
      lastReconciliationAt: 20_000,
    });
    const setup = coordinator({
      now: () => 10_000 + dayMs,
      runPredictions: async (_target, scan) => {
        calls.push(`predictions:${scan}`);
        return { kind: "completed" };
      },
    });

    await setup.value.recover();
    await setup.value.idle();

    expect(calls).toEqual(["predictions:full"]);
  });

  it("recover does not resume a user-paused workflow", async () => {
    await setWorkflowState({ ...structuredClone(DEFAULT_WORKFLOW_STATE), status: "paused", mode: "both" });
    const setup = coordinator();

    await setup.value.recover();
    await setup.value.idle();

    expect(setup.calls).toEqual([]);
  });

  it("interrupts active Predictions and starts Feed when Run Feed is clicked", async () => {
    const gate = deferred();
    const calls: string[] = [];
    let setup!: ReturnType<typeof coordinator>;
    setup = coordinator({
      runPredictions: async () => {
        calls.push("predictions:start");
        await gate.promise;
        calls.push(`predictions:paused=${setup.value.isPaused()}`);
        return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
      },
      runFeed: async () => {
        calls.push("feed");
        return { kind: "completed" };
      },
    });

    await setup.value.start("predictions");
    await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

    await setup.value.start("feed");
    expect(setup.value.isPaused()).toBe(true);

    gate.resolve();
    await setup.value.idle();

    expect(calls).toEqual(["predictions:start", "predictions:paused=true", "feed"]);
    expect(await chrome.alarms.get(WORKFLOW_ALARM_NAME)).toMatchObject({
      scheduledTime: 7_201_000,
    });
  });

  it("interrupts active Feed and starts Predictions when Run Predictions is clicked", async () => {
    const gate = deferred();
    const calls: string[] = [];
    let setup!: ReturnType<typeof coordinator>;
    setup = coordinator({
      runFeed: async () => {
        calls.push("feed:start");
        await gate.promise;
        calls.push(`feed:paused=${setup.value.isPaused()}`);
        return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
      },
      runPredictions: async (_targetAgentId, scan) => {
        calls.push(`predictions:${scan}`);
        return { kind: "completed" };
      },
    });

    await setup.value.start("feed");
    await vi.waitFor(() => expect(calls).toEqual(["feed:start"]));

    await setup.value.start("predictions");
    expect(setup.value.isPaused()).toBe(true);

    gate.resolve();
    await setup.value.idle();

    expect(calls).toEqual(["feed:start", "feed:paused=true", "predictions:full"]);
  });

  it("starts only the latest pending mode after repeated quick switches", async () => {
    const gate = deferred();
    const calls: string[] = [];
    let setup!: ReturnType<typeof coordinator>;
    setup = coordinator({
      runPredictions: async (_targetAgentId, scan) => {
        calls.push(`predictions:${scan}:start`);
        if (calls.length === 1) {
          await gate.promise;
          calls.push(`predictions:${scan}:paused=${setup.value.isPaused()}`);
          return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
        }
        return { kind: "completed" };
      },
      runFeed: async () => {
        calls.push("feed");
        return { kind: "completed" };
      },
    });

    await setup.value.start("predictions");
    await vi.waitFor(() => expect(calls).toEqual(["predictions:full:start"]));

    await setup.value.start("feed");
    await setup.value.start("both");

    gate.resolve();
    await setup.value.idle();

    expect(calls).toEqual([
      "predictions:full:start",
      "predictions:full:paused=true",
      "feed",
      "predictions:full:start",
    ]);
  });

  it("does not start pending mode when the user pauses after switching", async () => {
    const gate = deferred();
    const calls: string[] = [];
    let setup!: ReturnType<typeof coordinator>;
    setup = coordinator({
      runPredictions: async () => {
        calls.push("predictions:start");
        await gate.promise;
        calls.push(`predictions:paused=${setup.value.isPaused()}`);
        return setup.value.isPaused() ? { kind: "paused" } : { kind: "completed" };
      },
      runFeed: async () => {
        calls.push("feed");
        return { kind: "completed" };
      },
    });

    await setup.value.start("predictions");
    await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

    await setup.value.start("feed");
    await setup.value.pause();
    gate.resolve();
    await setup.value.idle();

    expect(calls).toEqual(["predictions:start", "predictions:paused=true"]);
    expect((await getWorkflowState()).status).toBe("paused");
  });

  it("keeps global runner failures from starting a pending mode", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const setup = coordinator({
      runPredictions: async () => {
        calls.push("predictions:start");
        await gate.promise;
        calls.push("predictions:failed");
        return { kind: "failed", reason: "backend rejected tx", global: true };
      },
      runFeed: async () => {
        calls.push("feed");
        return { kind: "completed" };
      },
    });

    await setup.value.start("predictions");
    await vi.waitFor(() => expect(calls).toEqual(["predictions:start"]));

    await setup.value.start("feed");
    gate.resolve();
    await setup.value.idle();

    expect(calls).toEqual(["predictions:start", "predictions:failed"]);
    expect(await getWorkflowState()).toMatchObject({
      status: "paused",
      mode: "feed",
      lastError: "backend rejected tx",
    });
  });

  it("does not let a delayed Feed cycle clear a pending Predictions switch", async () => {
    const releaseOldStateRead = deferred();
    const oldStateReadStarted = deferred();
    const calls: string[] = [];
    let state = structuredClone(DEFAULT_WORKFLOW_STATE);
    let stateReadCount = 0;
    let delayedState = "";
    let value!: WorkflowCoordinator;
    value = new WorkflowCoordinator({
      getConfig: async () => config,
      getState: async () => {
        stateReadCount += 1;
        const snapshot = structuredClone(state);
        if (stateReadCount === 2) {
          delayedState = `${snapshot.status}:${snapshot.mode}`;
          oldStateReadStarted.resolve();
          await releaseOldStateRead.promise;
        }
        return snapshot;
      },
      setState: async (nextState) => {
        state = structuredClone(nextState);
      },
      runFeed: async () => {
        calls.push(`feed:paused=${value.isPaused()}`);
        return value.isPaused() ? { kind: "paused" } : { kind: "completed" };
      },
      runPredictions: async () => {
        calls.push("predictions");
        return { kind: "completed" };
      },
      now: () => 1_000,
    });

    await value.start("feed");
    await oldStateReadStarted.promise;
    expect(delayedState).toBe("running:feed");

    await value.start("predictions");
    releaseOldStateRead.resolve();
    await value.idle();

    expect(calls).toEqual(["predictions"]);
    expect(state.mode).toBe("predictions");
  });
});
