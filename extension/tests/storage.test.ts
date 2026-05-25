import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { getVault, setVault, getConfig, setConfig } from "../src/background/storage.js";
import type { ExtensionConfig } from "../src/shared/types.js";
import type { Vault } from "../src/shared/crypto.js";

const fakeVault: Vault = {
  version: 1,
  salt: "c2FsdA==",
  iv: "aXY=",
  ciphertext: "Y2lwaGVy",
};

const fakeConfig: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
  dryRun: true,
  idleLockMinutes: 30,
  cooldownSeconds: 0,
  stopAtRemaining: 0,
  agentId: 0,
};

describe("storage", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("round-trips a vault", async () => {
    await setVault(fakeVault);
    expect(await getVault()).toEqual(fakeVault);
  });

  it("returns null when no vault is set", async () => {
    expect(await getVault()).toBeNull();
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
