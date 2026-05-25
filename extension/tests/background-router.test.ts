import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { encryptVault } from "../src/shared/crypto.js";
import { setVault, setConfig } from "../src/background/storage.js";
import { handleMessage } from "../src/background/index.js";

const TEST_KEY = "0x" + "11".repeat(32);

describe("background router (direct-only)", () => {
  beforeEach(async () => {
    installFakeChromeApi();
    await setVault(await encryptVault(TEST_KEY, "pw-123"));
    await setConfig({
      allowedOrigin: "https://evoevo.ai",
      allowedChain: "0G",
      chainId: 16661,
      rpcUrl: "https://rpc.example",
      allowedContracts: ["0x" + "ab".repeat(20)],
      allowedFunctionSelectors: ["0x4ed1f275"],
      maxFeeNative: 0.001,
      dryRun: true,
      idleLockMinutes: 30,
      cooldownSeconds: 0,
      stopAtRemaining: 0,
      agentId: 0,
    });
    // Reset module-level wallet state between tests.
    await handleMessage({ type: "lock" });
  });

  it("routes unlock and returns address", async () => {
    const response = await handleMessage({ type: "unlock", password: "pw-123" });
    expect(response).toMatchObject({ ok: true });
    expect((response as { address?: string }).address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("routes get-status with counts and running flag", async () => {
    const response = (await handleMessage({ type: "get-status" })) as Record<string, unknown>;
    expect(response.ok).toBe(true);
    expect(response.locked).toBe(true);
    expect(response.counts).toBeDefined();
    expect(response.running).toBe(false);
  });

  it("routes get-config with the stored extension config", async () => {
    const response = (await handleMessage({ type: "get-config" })) as {
      ok: boolean;
      config: { chainId: number; agentId: number };
    };
    expect(response.ok).toBe(true);
    expect(response.config.chainId).toBe(16661);
    expect(response.config.agentId).toBe(0);
  });

  it("get-agents fails when wallet is locked", async () => {
    const response = await handleMessage({ type: "get-agents" });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 4100 },
    });
  });

  it("start refuses to run when wallet is locked", async () => {
    const response = await handleMessage({ type: "start" });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 4100, message: "Wallet locked" },
    });
  });

  it("pause toggles the paused flag", async () => {
    await handleMessage({ type: "pause" });
    const status = (await handleMessage({ type: "get-status" })) as unknown as {
      paused: boolean;
    };
    expect(status.paused).toBe(true);
  });

  it("rejects unknown message types", async () => {
    const response = await handleMessage({ type: "nope" } as unknown);
    expect(response).toMatchObject({ ok: false });
    expect((response as { error: { code: number } }).error.code).toBe(-32600);
  });
});
