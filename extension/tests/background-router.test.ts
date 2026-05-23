import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { encryptVault } from "../src/shared/crypto.js";
import { setVault, setConfig } from "../src/background/storage.js";
import { handleMessage } from "../src/background/index.js";

const TEST_KEY = "0x" + "11".repeat(32);

describe("background router", () => {
  let chromeApi: ReturnType<typeof installFakeChromeApi>;

  beforeEach(async () => {
    chromeApi = installFakeChromeApi();
    await setVault(await encryptVault(TEST_KEY, "pw-123"));
    await setConfig({
      allowedOrigin: "https://evoevo.ai",
      allowedChain: "0G",
      chainId: 16661,
      rpcUrl: "https://rpc.example",
      allowedContracts: ["0x" + "ab".repeat(20)],
      allowedFunctionSelectors: ["0xd0e30db0"],
      maxFeeNative: 0.001,
      dryRun: true,
      idleLockMinutes: 30,
      cooldownSeconds: 0,
      stopAtRemaining: 0,
    });
    // Reset module-level wallet state
    await handleMessage({ type: "lock" }, {} as chrome.runtime.MessageSender);
  });

  it("routes unlock and returns address", async () => {
    const response = await handleMessage({ type: "unlock", password: "pw-123" }, {
      tab: { url: "https://evoevo.ai/feed" },
    } as chrome.runtime.MessageSender);
    expect(response).toMatchObject({ ok: true });
    expect((response as any).address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("routes get-status with counts", async () => {
    const response = await handleMessage({ type: "get-status" }, {} as chrome.runtime.MessageSender);
    expect(response).toMatchObject({ ok: true, locked: true });
    expect((response as any).counts).toBeDefined();
  });

  it("routes get-config with the stored extension config", async () => {
    const response = await handleMessage({ type: "get-config" }, {} as chrome.runtime.MessageSender);
    expect(response).toMatchObject({
      ok: true,
      config: {
        allowedOrigin: "https://evoevo.ai",
        allowedChain: "0G",
        chainId: 16661,
        rpcUrl: "https://rpc.example",
        maxFeeNative: 0.001,
        dryRun: true,
        idleLockMinutes: 30,
        cooldownSeconds: 0,
      },
    });
  });

  it("rejects unsupported write method", async () => {
    const response = await handleMessage(
      { type: "rpc-request", id: "1", method: "personal_sign", params: ["0xdata", "0xaddr"] },
      { tab: { url: "https://evoevo.ai/feed" } } as chrome.runtime.MessageSender,
    );
    expect(response).toMatchObject({ ok: false });
    expect((response as any).error.code).toBe(4200);
  });

  it("rejects rpc-request when automation is paused", async () => {
    // Pause automation
    await handleMessage({ type: "pause" }, {} as chrome.runtime.MessageSender);
    const response = await handleMessage(
      { type: "rpc-request", id: "1", method: "eth_sendTransaction", params: [{}] },
      { tab: { url: "https://evoevo.ai/feed" } } as chrome.runtime.MessageSender,
    );
    expect(response).toMatchObject({ ok: false });
    expect((response as any).error.code).toBe(4001);
    expect((response as any).error.message).toBe("Automation paused");
    // Resume for subsequent tests (reset state)
    await handleMessage({ type: "resume" }, {} as chrome.runtime.MessageSender);
  });

  it("updates paused status from automation paused events", async () => {
    await handleMessage({ type: "resume" }, {} as chrome.runtime.MessageSender);

    await handleMessage(
      { type: "automation-event", event: { type: "paused", reason: "Timed out waiting for transaction after click" } },
      {} as chrome.runtime.MessageSender,
    );

    const status = await handleMessage(
      { type: "get-status" },
      {} as chrome.runtime.MessageSender,
    );
    expect(status).toMatchObject({
      ok: true,
      paused: true,
      lastError: "Timed out waiting for transaction after click",
    });
  });

  it("reloads and resumes the sender tab after a reload_requested event", async () => {
    chromeApi.tabs._add({ id: 7, url: "https://evoevo.ai/feed?chainId=16661" });

    const response = await handleMessage(
      { type: "automation-event", event: { type: "reload_requested" } },
      { tab: { id: 7, url: "https://evoevo.ai/feed?chainId=16661" } } as chrome.runtime.MessageSender,
    );

    expect(response).toMatchObject({ ok: true });
    expect(chromeApi.tabs._reloads()).toEqual([7]);

    chromeApi.tabs._complete(7);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeApi.tabs._messages().at(-1)).toMatchObject({
      tabId: 7,
      message: {
        type: "start-automation",
        cooldownMs: 0,
        stopAtRemaining: 0,
      },
    });
  });
});
