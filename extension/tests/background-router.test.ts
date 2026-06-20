import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { clearPrivateKey, setConfig } from "../src/background/storage.js";
import { handleMessage } from "../src/background/index.js";

const TEST_KEY = "0x" + "11".repeat(32);

describe("background router (no password)", () => {
  beforeEach(async () => {
    installFakeChromeApi();
    await clearPrivateKey();
    // Also reset the module-level Wallet instance via the router so its
    // in-memory signer drops when previous tests imported a key.
    await handleMessage({ type: "clear-private-key" });
    await setConfig({
      allowedOrigin: "https://evoevo.ai",
      allowedChain: "0G",
      chainId: 16661,
      rpcUrl: "https://rpc.example",
      allowedContracts: ["0x" + "ab".repeat(20)],
      allowedFunctionSelectors: ["0x4ed1f275"],
      maxFeeNative: 0.001,
      gasPriceJitterPercent: 10,
      dryRun: true,
      cooldownSeconds: 0,
      stopAtRemaining: 0,
      agentId: 0,
      repeatIntervalMinutes: 120,
      reconciliationIntervalMinutes: 1440,
    });
  });

  it("set-private-key stores the key and exposes the address", async () => {
    const response = await handleMessage({
      type: "set-private-key",
      privateKey: TEST_KEY,
    });
    expect(response).toMatchObject({ ok: true });
    expect((response as { address?: string }).address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("set-private-key rejects malformed keys", async () => {
    const response = await handleMessage({
      type: "set-private-key",
      privateKey: "0x" + "11".repeat(31),
    });
    expect(response).toMatchObject({ ok: false });
  });

  it("clear-private-key removes the key and makes wallet not-ready", async () => {
    await handleMessage({ type: "set-private-key", privateKey: TEST_KEY });
    await handleMessage({ type: "clear-private-key" });
    const status = (await handleMessage({ type: "get-status" })) as unknown as {
      ready: boolean;
    };
    expect(status.ready).toBe(false);
  });

  it("get-status returns ready=true after a key is set", async () => {
    await handleMessage({ type: "set-private-key", privateKey: TEST_KEY });
    const status = (await handleMessage({ type: "get-status" })) as unknown as {
      ready: boolean;
      address: string;
    };
    expect(status.ready).toBe(true);
    expect(status.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("start refuses to run before a key is set", async () => {
    const response = await handleMessage({ type: "start" });
    expect(response).toMatchObject({ ok: false });
  });

  it("get-agents fails before a key is set", async () => {
    const response = await handleMessage({ type: "get-agents" });
    expect(response).toMatchObject({ ok: false });
  });

  it("rejects unknown message types", async () => {
    const response = await handleMessage({ type: "nope" } as unknown);
    expect(response).toMatchObject({ ok: false });
    expect((response as { error: { code: number } }).error.code).toBe(-32600);
  });
});
