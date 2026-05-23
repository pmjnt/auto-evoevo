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

  it("starts automation in a dedicated EvoEvo tab", async () => {
    const response = await handleMessage(
      { type: "start-dedicated" },
      {} as chrome.runtime.MessageSender,
    );

    expect(response).toMatchObject({
      ok: true,
      tabId: 1,
      created: true,
      tabsNotified: 1,
    });
    expect(chromeApi.tabs._tabs()).toMatchObject([
      { id: 1, url: "https://evoevo.ai/feed?chainId=16661" },
    ]);
    expect(chromeApi.tabs._messages()).toMatchObject([
      {
        tabId: 1,
        message: {
          type: "start-automation",
          cooldownMs: 0,
          stopAtRemaining: 0,
        },
      },
    ]);
  });

  it("reports when the dedicated automation tab is closed", async () => {
    const startResponse = await handleMessage(
      { type: "start-dedicated" },
      {} as chrome.runtime.MessageSender,
    );
    const tabId = (startResponse as unknown as { tabId: number }).tabId;

    chromeApi.tabs._remove(tabId);

    const status = await handleMessage(
      { type: "get-status" },
      {} as chrome.runtime.MessageSender,
    );
    expect(status).toMatchObject({
      ok: true,
      automationTab: { state: "closed", id: tabId },
    });
  });
});
