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
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
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

  it("rejects invalid stored config shape", async () => {
    await chrome.storage.local.set({ config: { allowedOrigin: 42 } });
    await expect(getConfig()).rejects.toThrow();
  });
});
