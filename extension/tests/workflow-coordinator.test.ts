import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { DEFAULT_WORKFLOW_STATE, getWorkflowState, setWorkflowState } from "../src/background/storage.js";
import { WorkflowCoordinator } from "../src/background/workflow-coordinator.js";
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

  it("pause clears the next alarm and persists paused", async () => {
    const setup = coordinator();
    await setup.value.start("feed");
    await setup.value.idle();

    await setup.value.pause();

    expect((await getWorkflowState()).status).toBe("paused");
    expect(await chrome.alarms.get("workflow-cycle")).toBeUndefined();
  });

  it("recover does not resume a user-paused workflow", async () => {
    await setWorkflowState({ ...structuredClone(DEFAULT_WORKFLOW_STATE), status: "paused", mode: "both" });
    const setup = coordinator();

    await setup.value.recover();
    await setup.value.idle();

    expect(setup.calls).toEqual([]);
  });
});
