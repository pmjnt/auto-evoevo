// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Message = { type: string; [key: string]: unknown };

const config = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://evmrpc.0g.ai",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
  dryRun: true,
  idleLockMinutes: 30,
  cooldownSeconds: 3,
  overrideWalletProvider: false,
  stopAtRemaining: 10,
};

function setupPopupDom(): void {
  document.body.innerHTML = `
    <section id="locked"></section>
    <section id="unlocked"></section>
    <input id="password" value="pw" />
    <button id="unlock"></button>
    <button id="lock"></button>
    <button id="pause"></button>
    <button id="start"></button>
    <input id="override-wallet" type="checkbox" checked />
    <div id="unlock-error"></div>
    <div id="address"></div>
    <div id="signed"></div>
    <div id="dry"></div>
    <div id="manual"></div>
    <div id="rejected"></div>
    <div id="runtime-error"></div>
    <div id="status-text"></div>
    <div id="start-msg"></div>
  `;
}

function installRuntimeStub(): Message[] {
  const messages: Message[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (message: Message, callback: (response: unknown) => void) => {
        messages.push(message);
        if (message.type === "get-status") {
          callback({
            ok: true,
            locked: false,
            address: "0xabc",
            paused: false,
            counts: {},
            automationStatus: "running",
          });
          return;
        }
        if (message.type === "get-config") {
          callback({ ok: true, config });
          return;
        }
        callback({ ok: true });
      },
    },
  };
  return messages;
}

describe("popup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    setupPopupDom();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads and saves the wallet override toggle in the side panel", async () => {
    const messages = installRuntimeStub();

    await import("../src/ui/popup.js");
    await Promise.resolve();
    await Promise.resolve();

    const toggle = document.getElementById("override-wallet") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    const saveMessage = messages.find((message) => message.type === "set-config");
    expect(saveMessage?.config).toMatchObject({
      ...config,
      overrideWalletProvider: true,
    });
  });
});
