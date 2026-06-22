import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import {
  clearPrivateKey,
  DEFAULT_WORKFLOW_STATE,
  getConfig,
  getPredictionIds,
  getPrivateKey,
  getWorkflowState,
  setConfig,
  setPredictionIds,
  setPrivateKey,
  setWorkflowState,
} from "../src/background/storage.js";
import type { ExtensionConfig } from "../src/shared/types.js";

const fakeConfig: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb71442749d13a4bb7257dfbfff0452ae937f9"],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.001,
  gasPriceJitterPercent: 10,
  dryRun: true,
  cooldownSeconds: 0,
  memoryApiCooldownSeconds: 1,
  predictionReadCooldownSeconds: 2,
  rateLimitBackoffMinutes: 15,
  stopAtRemaining: 0,
  agentId: 0,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

const TEST_KEY = "0x" + "11".repeat(32);

describe("storage", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("round-trips a private key", async () => {
    await setPrivateKey(TEST_KEY);
    expect(await getPrivateKey()).toBe(TEST_KEY);
  });

  it("returns null when no key is stored", async () => {
    expect(await getPrivateKey()).toBeNull();
  });

  it("rejects a malformed private key", async () => {
    await expect(setPrivateKey("not-hex")).rejects.toThrow();
  });

  it("clear removes the key", async () => {
    await setPrivateKey(TEST_KEY);
    await clearPrivateKey();
    expect(await getPrivateKey()).toBeNull();
  });

  it("round-trips config", async () => {
    await setConfig(fakeConfig);
    expect(await getConfig()).toEqual(fakeConfig);
  });

  it("defaults gas jitter for old stored config", async () => {
    const { gasPriceJitterPercent: _ignored, ...oldConfig } = fakeConfig;
    await chrome.storage.local.set({ config: oldConfig });
    expect(await getConfig()).toEqual(fakeConfig);
  });

  it("defaults workflow intervals for old stored config", async () => {
    const {
      repeatIntervalMinutes: _repeat,
      reconciliationIntervalMinutes: _reconciliation,
      ...oldConfig
    } = fakeConfig;
    await chrome.storage.local.set({ config: oldConfig });

    expect(await getConfig()).toEqual(fakeConfig);
  });

  it("defaults predictions rate limit controls for old stored config", async () => {
    const {
      memoryApiCooldownSeconds: _memoryApiCooldownSeconds,
      predictionReadCooldownSeconds: _predictionReadCooldownSeconds,
      rateLimitBackoffMinutes: _rateLimitBackoffMinutes,
      ...oldConfig
    } = fakeConfig;
    await chrome.storage.local.set({ config: oldConfig });

    expect(await getConfig()).toEqual(fakeConfig);
  });

  it("defaults prediction read cooldown for older configs", async () => {
    const {
      predictionReadCooldownSeconds: _predictionReadCooldownSeconds,
      ...legacy
    } = fakeConfig;
    await chrome.storage.local.set({ config: legacy });

    await expect(getConfig()).resolves.toMatchObject({
      predictionReadCooldownSeconds: 2,
    });
  });

  it("migrates old intakeReasoning selectors to intakeReasoningV2", async () => {
    await chrome.storage.local.set({
      config: {
        ...fakeConfig,
        allowedFunctionSelectors: ["0x4ed1f275", "0xd0e30db0"],
      },
    });

    expect(await getConfig()).toEqual({
      ...fakeConfig,
      allowedFunctionSelectors: ["0xa29adb25"],
    });
  });

  it("rejects invalid stored config shape", async () => {
    await chrome.storage.local.set({ config: { allowedOrigin: 42 } });
    await expect(getConfig()).rejects.toThrow();
  });

  it("round-trips workflow state and defaults when absent", async () => {
    expect(await getWorkflowState()).toEqual(DEFAULT_WORKFLOW_STATE);
    const state = {
      ...structuredClone(DEFAULT_WORKFLOW_STATE),
      status: "paused" as const,
      sourceAgentIds: [3314, 4420],
    };
    await setWorkflowState(state);
    expect(await getWorkflowState()).toEqual(state);
  });

  it("defaults prediction scan checkpoint fields for older workflow state", async () => {
    const legacy = structuredClone(DEFAULT_WORKFLOW_STATE) as Partial<typeof DEFAULT_WORKFLOW_STATE>;
    delete legacy.completedPredictionSourceIds;
    delete legacy.predictionScanStartedAt;
    await chrome.storage.local.set({ workflowState: legacy });

    await expect(getWorkflowState()).resolves.toMatchObject({
      completedPredictionSourceIds: [],
      predictionScanStartedAt: null,
    });
  });

  it("sorts and deduplicates prediction ids", async () => {
    await setPredictionIds(["p2", "p1", "p2"]);
    expect(await getPredictionIds()).toEqual(["p1", "p2"]);
  });
});
