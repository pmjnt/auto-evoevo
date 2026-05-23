// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

type Message = { type: string; [key: string]: unknown };

function setupOptionsDom(): void {
  document.body.innerHTML = `
    <input id="rpcUrl" value="https://evmrpc.0g.ai" />
    <input id="chainId" value="16661" />
    <input id="maxFeeNative" value="0.001" />
    <input id="cooldownSeconds" value="7" />
    <input id="stopAtRemaining" value="10" />
    <input id="allowedContracts" value="0x61bb710000000000000000000000000000e937f9" />
    <input id="allowedFunctionSelectors" value="0xd0e30db0" />
    <input id="dryRun" type="checkbox" checked />
    <input id="overrideWalletProvider" type="checkbox" checked />
    <input id="privateKey" value="" />
    <input id="password" value="" />
    <button id="save">Save configuration</button>
    <div id="msg"></div>
  `;
}

function installRuntimeStub(): Message[] {
  const messages: Message[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (message: Message, callback: (response: unknown) => void) => {
        messages.push(message);
        callback(message.type === "get-config" ? { ok: true, config: null } : { ok: true });
      },
    },
  };
  return messages;
}

describe("options page", () => {
  beforeEach(() => {
    vi.resetModules();
    setupOptionsDom();
  });

  it("saves configuration even when optional legacy fields are not rendered", async () => {
    const messages = installRuntimeStub();

    await import("../src/ui/options.js");
    await Promise.resolve();
    (document.getElementById("cooldownSeconds") as HTMLInputElement).value = "7";
    document.getElementById("save")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const saveMessage = messages.find((message) => message.type === "set-config");
    expect(saveMessage).toBeDefined();
    expect(saveMessage?.config).toMatchObject({
      cooldownSeconds: 7,
      idleLockMinutes: 30,
      overrideWalletProvider: true,
    });
    expect(document.getElementById("msg")?.textContent).toBe("Saved");
  });
});
