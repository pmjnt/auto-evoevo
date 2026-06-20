// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";

const sendMock = vi.fn();

vi.mock("../src/ui/shared.js", () => ({
  send: sendMock,
}));

const popupHtml = readFileSync(
  resolve("src/ui/popup.html"),
  "utf8",
);

const config = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x" + "ab".repeat(20)],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.01,
  gasPriceJitterPercent: 10,
  dryRun: true,
  cooldownSeconds: 0,
  memoryApiCooldownSeconds: 1,
  rateLimitBackoffMinutes: 15,
  stopAtRemaining: 0,
  agentId: 0,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

async function mountPopup(): Promise<void> {
  document.open();
  document.write(popupHtml.replace('<script src="popup.js"></script>', ""));
  document.close();
  vi.resetModules();
  await import("../src/ui/popup.js");
  await vi.waitFor(() => {
    expect(document.getElementById("ready")?.classList.contains("active")).toBe(true);
  });
}

describe("popup workflow console", () => {
  beforeEach(() => {
    installFakeChromeApi();
    sendMock.mockReset();
    sendMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === "get-status") {
        return {
          ok: true,
          ready: true,
          address: "0x" + "11".repeat(20),
          paused: false,
          counts: {},
        };
      }
      if (message.type === "get-config") return { ok: true, config };
      return { ok: true, started: true };
    });
  });

  it.each([
    ["repeatIntervalMinutes", "29"],
    ["repeatIntervalMinutes", "1441"],
    ["reconciliationIntervalMinutes", "29"],
    ["reconciliationIntervalMinutes", "1441"],
  ])("rejects invalid %s value %s before saving", async (id, value) => {
    await mountPopup();
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;

    (document.getElementById("runFeed") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(document.getElementById("start-msg")?.textContent).toContain("30");
    });
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-config" }),
    );
  });

  it("requires a target agent before running Predictions", async () => {
    await mountPopup();

    (document.getElementById("runPredictions") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(document.getElementById("start-msg")?.textContent).toContain("target agent");
    });
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-config" }),
    );
  });

  it("uses an operational layout without decorative gradients", () => {
    expect(popupHtml).toContain('id="runBoth"');
    expect(popupHtml).toContain('id="feed-panel"');
    expect(popupHtml).toContain('id="predictions-panel"');
    expect(popupHtml).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it("routes workflow activity through the event formatter", () => {
    const popupSource = readFileSync(resolve("src/ui/popup.ts"), "utf8");
    expect(popupSource).toContain("formatWorkflowEvent(event)");
  });

  it("exposes predictions rate limit controls", () => {
    const popupSource = readFileSync(resolve("src/ui/popup.ts"), "utf8");
    expect(popupHtml).toContain('id="memoryApiCooldownSeconds"');
    expect(popupHtml).toContain('id="rateLimitBackoffMinutes"');
    expect(popupSource).toContain("memoryApiCooldownSeconds: clampInt");
    expect(popupSource).toContain("rateLimitBackoffMinutes: clampInt");
  });
});
