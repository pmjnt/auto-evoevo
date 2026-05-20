import type { BrowserContext, Page } from "playwright";

import { evaluateWalletRequest } from "../guard.js";
import type { GuardDecision, RunnerConfig, WalletRequest } from "../types.js";
import { parseRabbyText } from "./parse.js";

export type SignResult = {
  request: WalletRequest;
  decision: GuardDecision;
  signed: boolean;
};

function isRabbyPopup(page: Page): boolean {
  return page.url().startsWith("chrome-extension://");
}

export async function waitForRabbyPopup(
  context: BrowserContext,
  timeoutMs: number,
): Promise<Page> {
  const existingPopup = context.pages().find(isRabbyPopup);

  if (existingPopup !== undefined) {
    return existingPopup;
  }

  return context.waitForEvent("page", {
    predicate: isRabbyPopup,
    timeout: timeoutMs,
  });
}

export async function signRabbyPopup(
  context: BrowserContext,
  config: RunnerConfig,
): Promise<SignResult> {
  const popup = await waitForRabbyPopup(context, config.timeoutsMs.popup);

  await popup.waitForLoadState("domcontentloaded", {
    timeout: config.timeoutsMs.signing,
  });

  const rawText = await popup.locator("body").innerText({
    timeout: config.timeoutsMs.signing,
  });
  const request = parseRabbyText(rawText);
  const decision = evaluateWalletRequest(request, config);

  if (decision.status !== "approve" || config.dryRun) {
    return {
      request,
      decision,
      signed: false,
    };
  }

  await popup.getByRole("button", { name: /^Sign$/i }).click({
    timeout: config.timeoutsMs.signing,
  });

  return {
    request,
    decision,
    signed: true,
  };
}
