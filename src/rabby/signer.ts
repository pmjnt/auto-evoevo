import type { BrowserContext, Page } from "playwright";

import { evaluateWalletRequest } from "../guard.js";
import type { GuardDecision, RunnerConfig, WalletRequest } from "../types.js";
import { parseRabbyText } from "./parse.js";

export type SignResult = {
  request: WalletRequest;
  decision: GuardDecision;
  signed: boolean;
};

const RABBY_CONTENT_PATTERN =
  /(Simulation Results|Unknown Signature Type|Interact contract)/i;

function rabbyPopupUrlPrefix(config: RunnerConfig): string {
  return `chrome-extension://${config.rabbyExtensionId}/`;
}

function isRabbyPopup(page: Page, config: RunnerConfig): boolean {
  return page.url().startsWith(rabbyPopupUrlPrefix(config));
}

export async function waitForRabbyPopup(
  context: BrowserContext,
  config: RunnerConfig,
): Promise<Page> {
  return await context.waitForEvent("page", {
    predicate: (page) => isRabbyPopup(page, config),
    timeout: config.timeoutsMs.popup,
  });
}

export async function signRabbyPopup(
  context: BrowserContext,
  config: RunnerConfig,
): Promise<SignResult> {
  const popup = await waitForRabbyPopup(context, config);

  await popup.waitForLoadState("domcontentloaded", {
    timeout: config.timeoutsMs.signing,
  });

  const rawText = await popup.locator("body").innerText({
    timeout: config.timeoutsMs.signing,
  });
  const request = parseRabbyText(rawText);
  const decision = evaluateWalletRequest(request, config);

  if (
    decision.status !== "approve" ||
    config.dryRun ||
    !RABBY_CONTENT_PATTERN.test(rawText)
  ) {
    return {
      request,
      decision: RABBY_CONTENT_PATTERN.test(rawText)
        ? decision
        : {
            status: "needs_manual_review",
            reason: "Rabby popup content could not be verified",
          },
      signed: false,
    };
  }

  const signButtons = popup.getByRole("button", { name: /^Sign$/i });
  const visibleSignButtonCount = await signButtons.count();

  if (visibleSignButtonCount !== 1) {
    return {
      request,
      decision: {
        status: "needs_manual_review",
        reason: "Rabby Sign button was not uniquely available",
      },
      signed: false,
    };
  }

  await signButtons.first().click({
    timeout: config.timeoutsMs.signing,
  });

  return {
    request,
    decision,
    signed: true,
  };
}
