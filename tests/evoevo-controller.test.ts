import { describe, expect, test } from "vitest";
import type { Locator, Page } from "playwright";

import { EvoEvoController } from "../src/evoevo/controller.js";
import type { RunnerConfig } from "../src/types.js";

type ButtonState = {
  visible: boolean;
  enabled: boolean;
  text: string;
  articleText: string | null;
  divTexts: string[];
  attemptedId: string | null;
  clicked: boolean;
};

class FakeButtonCollection {
  constructor(private readonly buttons: ButtonState[]) {}

  async count(): Promise<number> {
    return this.buttons.length;
  }

  nth(index: number): Locator {
    return new FakePositionalLocator(this.buttons, index) as unknown as Locator;
  }
}

class FakePositionalLocator {
  constructor(
    private readonly buttons: ButtonState[],
    private readonly index: number,
  ) {}

  protected state(): ButtonState {
    const state = this.buttons[this.index];

    if (state === undefined) {
      throw new Error("Missing button");
    }

    return state;
  }

  async isVisible(): Promise<boolean> {
    return this.state().visible;
  }

  async isEnabled(): Promise<boolean> {
    return this.state().enabled;
  }

  async getAttribute(name: string): Promise<string | null> {
    return name === "data-auto-evoevo-attempted-id"
      ? this.state().attemptedId
      : null;
  }

  async evaluate(
    callback: (
      element: { setAttribute: (name: string, value: string) => void },
      id: string,
    ) => void,
    id: string,
  ): Promise<void> {
    const state = this.state();

    callback(
      {
        setAttribute(name, value) {
          if (name === "data-auto-evoevo-attempted-id") {
            state.attemptedId = value;
          }
        },
      },
      id,
    );
  }

  locator(selector: string): Locator {
    return new FakeAncestorLocator(this.state(), selector) as unknown as Locator;
  }

  async scrollIntoViewIfNeeded(): Promise<void> {}

  async click(): Promise<void> {
    this.state().clicked = true;
  }
}

class FakeStableLocator extends FakePositionalLocator {
  constructor(
    private readonly stableButtons: ButtonState[],
    private readonly attemptedId: string,
  ) {
    super(stableButtons, -1);
  }

  protected override state(): ButtonState {
    const state = this.stableButtons.find(
      (button) => button.attemptedId === this.attemptedId,
    );

    if (state === undefined) {
      throw new Error("Missing stable button");
    }

    return state;
  }
}

class FakeAncestorLocator {
  constructor(
    private readonly button: ButtonState,
    private readonly selector: string,
  ) {}

  async count(): Promise<number> {
    if (this.selector.includes("article")) {
      return this.button.articleText === null ? 0 : 1;
    }

    const match = this.selector.match(/ancestor::div\[(\d+)\]/);

    if (match === null) {
      return 0;
    }

    return this.button.divTexts[Number(match[1]) - 1] === undefined ? 0 : 1;
  }

  async innerText(): Promise<string> {
    if (this.selector.includes("article")) {
      if (this.button.articleText === null) {
        throw new Error("Missing article");
      }

      return this.button.articleText;
    }

    const match = this.selector.match(/ancestor::div\[(\d+)\]/);
    const text =
      match === null ? undefined : this.button.divTexts[Number(match[1]) - 1];

    if (text === undefined) {
      throw new Error("Missing div");
    }

    return text;
  }
}

class FakePage {
  constructor(readonly buttons: ButtonState[]) {}

  getByRole(): Locator {
    return new FakeButtonCollection(this.buttons) as unknown as Locator;
  }

  locator(selector: string): Locator {
    const match = selector.match(
      /^\[data-auto-evoevo-attempted-id="([^"]+)"\]$/,
    );

    if (match === null) {
      throw new Error(`Unexpected selector: ${selector}`);
    }

    return new FakeStableLocator(
      this.buttons,
      match[1] ?? "",
    ) as unknown as Locator;
  }
}

const config: RunnerConfig = {
  evoevoUrl: "https://evo.example/feed",
  chromeProfilePath: "profile",
  rabbyExtensionId: "rabby",
  allowedOrigin: "https://evo.example",
  allowedChain: "chain",
  allowedContracts: [],
  maxFeeNative: 1,
  allowLearnedActionPattern: false,
  dryRun: true,
  timeoutsMs: {
    pageLoad: 100,
    popup: 100,
    signing: 100,
    feedExpansion: 100,
  },
  logDir: "logs",
};

describe("EvoEvoController", () => {
  test("marks selected memory buttons and returns a stable locator", async () => {
    const attempted: ButtonState = {
      visible: true,
      enabled: true,
      text: "Add to memory",
      articleText: "Already attempted\nADD TO MEMORY",
      divTexts: [],
      attemptedId: "existing",
      clicked: false,
    };
    const selected: ButtonState = {
      visible: true,
      enabled: true,
      text: "Add to memory",
      articleText: "ADD TO MEMORY\nUseful memory title\nYES/NO",
      divTexts: [],
      attemptedId: null,
      clicked: false,
    };
    const page = new FakePage([attempted, selected]);
    const controller = new EvoEvoController(page as unknown as Page, config);

    const button = await controller.nextMemoryButton();

    expect(button?.index).toBe(1);
    expect(button?.label).toBe("Useful memory title");
    expect(selected.attemptedId).toBe("1");

    page.buttons.unshift({
      visible: true,
      enabled: true,
      text: "Add to memory",
      articleText: "New first item",
      divTexts: [],
      attemptedId: null,
      clicked: false,
    });

    await controller.clickMemoryButton(button!);

    expect(selected.clicked).toBe(true);
    expect(page.buttons[1]?.clicked).toBe(false);
  });

  test("falls back to broader card text and ignores control labels", async () => {
    const selected: ButtonState = {
      visible: true,
      enabled: true,
      text: "Add to memory",
      articleText: null,
      divTexts: [
        "ADD TO MEMORY",
        "CRYPTO\nSHOW MORE\nBroader card title\nRESOLVE",
      ],
      attemptedId: null,
      clicked: false,
    };
    const controller = new EvoEvoController(
      new FakePage([selected]) as unknown as Page,
      config,
    );

    const button = await controller.nextMemoryButton();

    expect(button?.label).toBe("Broader card title");
  });
});
