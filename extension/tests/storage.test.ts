import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import {
  clearPrivateKey,
  getConfig,
  getPrivateKey,
  setConfig,
  setPrivateKey,
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
  stopAtRemaining: 0,
  agentId: 0,
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
});
