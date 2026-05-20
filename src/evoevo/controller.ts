import type { Locator, Page } from "playwright";

import type { RunnerConfig } from "../types.js";

export type MemoryButton = {
  locator: Locator;
  index: number;
  label: string | null;
};

export class EvoEvoController {
  constructor(
    private readonly page: Page,
    private readonly config: RunnerConfig,
  ) {}

  async openFeed(): Promise<void> {
    await this.page.goto(this.config.evoevoUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeoutsMs.pageLoad,
    });

    const url = new URL(this.page.url());

    if (url.origin !== this.config.allowedOrigin) {
      throw new Error(`Unexpected EvoEvo page origin: ${url.origin}`);
    }
  }

  async nextMemoryButton(): Promise<MemoryButton | null> {
    const buttons = this.addToMemoryButtons();
    const count = await buttons.count();

    for (let index = 0; index < count; index += 1) {
      const locator = buttons.nth(index);

      if ((await locator.isVisible()) && (await locator.isEnabled())) {
        return {
          locator,
          index,
          label: await this.cardLabelFor(locator),
        };
      }
    }

    return null;
  }

  async clickMemoryButton(button: MemoryButton): Promise<void> {
    await button.locator.scrollIntoViewIfNeeded({
      timeout: this.config.timeoutsMs.pageLoad,
    });
    await button.locator.click({
      timeout: this.config.timeoutsMs.pageLoad,
    });
  }

  async clickShowMore(): Promise<boolean> {
    const showMore = this.page
      .getByRole("button", { name: /show more/i })
      .first();

    if (!(await showMore.isVisible().catch(() => false))) {
      return false;
    }

    if (!(await showMore.isEnabled().catch(() => false))) {
      return false;
    }

    await showMore.scrollIntoViewIfNeeded({
      timeout: this.config.timeoutsMs.feedExpansion,
    });

    const before = await this.addToMemoryButtons().count();

    await showMore.click({
      timeout: this.config.timeoutsMs.feedExpansion,
    });

    await this.page
      .waitForFunction(
        (previousCount) => {
          const buttons = Array.from(document.querySelectorAll("button"));

          return (
            buttons.filter((button) =>
              /add to memory/i.test(button.textContent ?? ""),
            ).length > previousCount
          );
        },
        before,
        {
          timeout: this.config.timeoutsMs.feedExpansion,
        },
      )
      .catch(() => undefined);

    const after = await this.addToMemoryButtons().count();

    return after > before;
  }

  private addToMemoryButtons(): Locator {
    return this.page.getByRole("button", { name: /add to memory/i });
  }

  private async cardLabelFor(button: Locator): Promise<string | null> {
    const card = button.locator(
      "xpath=ancestor::*[self::article or self::div][1]",
    );
    const text = await card.innerText({ timeout: 1000 }).catch(() => null);

    if (text === null) {
      return null;
    }

    return (
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    );
  }
}
