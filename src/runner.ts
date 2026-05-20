import { chromium } from "playwright";

import { EvoEvoController } from "./evoevo/controller.js";
import { SessionLogger } from "./logger.js";
import { signRabbyPopup } from "./rabby/signer.js";
import type { AttemptLog, AttemptStatus, RunnerConfig } from "./types.js";

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attemptStatus(
  config: RunnerConfig,
  signed: boolean,
): AttemptStatus {
  if (config.dryRun) {
    return "dry_run";
  }

  return signed ? "signed" : "manual_review";
}

function attemptReason(config: RunnerConfig, decisionReason: string): string {
  return config.dryRun ? `Dry run: ${decisionReason}` : decisionReason;
}

export async function run(config: RunnerConfig): Promise<void> {
  const logger = new SessionLogger(config.logDir);
  const context = await chromium.launchPersistentContext(
    config.chromeProfilePath,
    {
      headless: false,
      channel: "chrome",
    },
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const controller = new EvoEvoController(page, config);
    let idleExpansions = 0;
    let emptyExpansionStreak = 0;

    await controller.openFeed();

    while (idleExpansions < 2) {
      const button = await controller.nextMemoryButton();

      if (button === null) {
        const expanded = await controller.clickShowMore();

        if (expanded) {
          idleExpansions = 0;
          emptyExpansionStreak += 1;

          if (emptyExpansionStreak >= 2) {
            break;
          }
        } else {
          idleExpansions += 1;
        }

        continue;
      }

      emptyExpansionStreak = 0;

      try {
        await controller.clickMemoryButton(button);

        const signResult = await signRabbyPopup(context, config);
        const status = attemptStatus(config, signResult.signed);
        const entry: AttemptLog = {
          timestamp: new Date().toISOString(),
          evoevoUrl: page.url(),
          cardLabel: button.label,
          buttonIndex: button.index,
          walletRequest: signResult.request,
          decision: signResult.decision,
          status,
          reason: attemptReason(config, signResult.decision.reason),
        };

        logger.record(entry);

        // A non-approve dry-run still leaves the Rabby popup in a state that
        // may need manual handling, so pause instead of advancing automation.
        if (signResult.decision.status !== "approve") {
          console.error(`Paused: ${signResult.decision.reason}`);
          break;
        }
      } catch (error) {
        logger.record({
          timestamp: new Date().toISOString(),
          evoevoUrl: page.url(),
          cardLabel: button.label,
          buttonIndex: button.index,
          walletRequest: null,
          decision: null,
          status: "failed",
          reason: errorReason(error),
        });
        console.error(`Paused: ${errorReason(error)}`);
        break;
      }
    }

    console.log("Session summary:", logger.summary());
    console.log(`Session log: ${logger.filePath}`);
  } finally {
    await context.close();
  }
}
