import type { BrowserContext, Page } from "playwright";
import { describe, expect, test } from "vitest";

import {
  signRabbyPopup,
  waitForRabbyPopup,
} from "../src/rabby/signer.js";
import type { RunnerConfig } from "../src/types.js";

const RABBY_EXTENSION_ID = "acmacodkjbdgmoleebolmdjonilkdbch";
const CONTRACT = "0x61bb710000000000000000000000000000e937f9";

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    evoevoUrl: "https://evoevo.ai/feed",
    chromeProfilePath: "chrome-profile",
    rabbyExtensionId: RABBY_EXTENSION_ID,
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    allowedContracts: [CONTRACT],
    maxFeeNative: 0.001,
    allowLearnedActionPattern: false,
    dryRun: true,
    timeoutsMs: {
      pageLoad: 30000,
      popup: 20000,
      signing: 30000,
      feedExpansion: 15000,
    },
    logDir: "logs",
    ...overrides,
  };
}

const validRabbyText = [
  "https://evoevo.ai",
  "Unknown Signature Type",
  "Chain",
  "0G",
  "Interact contract",
  CONTRACT,
  "Network fee 0.000416 OG",
  "Simulation Results",
  "Sign",
].join("\n");

type FakePageOptions = {
  url?: string;
  bodyText?: string;
  signButtonCount?: number;
};

type FakePage = Page & {
  clickCount: number;
};

function fakePage(options: FakePageOptions = {}): FakePage {
  let clickCount = 0;
  const page = {
    url: () =>
      options.url ?? `chrome-extension://${RABBY_EXTENSION_ID}/popup.html`,
    waitForLoadState: async () => undefined,
    locator: () => ({
      innerText: async () => options.bodyText ?? validRabbyText,
    }),
    getByRole: () => ({
      count: async () => options.signButtonCount ?? 1,
      first: () => ({
        click: async () => {
          clickCount += 1;
        },
      }),
    }),
    get clickCount() {
      return clickCount;
    },
  };

  return page as unknown as FakePage;
}

function fakeContext(options: {
  pages?: Page[];
  eventPage?: Page;
  eventError?: Error;
}): BrowserContext {
  return {
    pages: () => options.pages ?? [],
    waitForEvent: async (
      eventName: string,
      eventOptions: { predicate?: (page: Page) => boolean },
    ) => {
      if (eventName !== "page") {
        throw new Error(`Unexpected event: ${eventName}`);
      }

      if (options.eventError !== undefined) {
        throw options.eventError;
      }

      if (
        options.eventPage !== undefined &&
        (eventOptions.predicate?.(options.eventPage) ?? true)
      ) {
        return options.eventPage;
      }

      throw new Error("No matching page event");
    },
  } as unknown as BrowserContext;
}

describe("waitForRabbyPopup", () => {
  test("ignores other chrome-extension pages", async () => {
    const otherExtensionPage = fakePage({
      url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/popup.html",
    });

    await expect(
      waitForRabbyPopup(
        fakeContext({
          pages: [otherExtensionPage],
          eventError: new Error("timeout"),
        }),
        config(),
      ),
    ).rejects.toThrow("timeout");
  });

  test("prefers a newly-created matching Rabby popup over an existing one", async () => {
    const existingPage = fakePage({
      url: `chrome-extension://${RABBY_EXTENSION_ID}/existing.html`,
    });
    const newPage = fakePage({
      url: `chrome-extension://${RABBY_EXTENSION_ID}/popup.html`,
    });

    await expect(
      waitForRabbyPopup(
        fakeContext({ pages: [existingPage], eventPage: newPage }),
        config(),
      ),
    ).resolves.toBe(newPage);
  });
});

describe("signRabbyPopup", () => {
  test("refuses non-Rabby-like content", async () => {
    const page = fakePage({
      bodyText: [
        "https://evoevo.ai",
        "Chain",
        "0G",
        "Contract",
        CONTRACT,
        "Network fee 0.000416 OG",
        "Sign",
      ].join("\n"),
    });

    await expect(
      signRabbyPopup(
        fakeContext({ pages: [page], eventError: new Error("timeout") }),
        config({ dryRun: false }),
      ),
    ).resolves.toMatchObject({
      signed: false,
      decision: {
        status: "needs_manual_review",
        reason: "Rabby popup content could not be verified",
      },
    });
  });

  test("dryRun avoids clicking", async () => {
    const page = fakePage();

    await expect(
      signRabbyPopup(
        fakeContext({ pages: [page], eventError: new Error("timeout") }),
        config({ dryRun: true }),
      ),
    ).resolves.toMatchObject({ signed: false });
    expect(page.clickCount).toBe(0);
  });

  test("zero visible Sign buttons avoid clicking", async () => {
    const page = fakePage({ signButtonCount: 0 });

    await expect(
      signRabbyPopup(
        fakeContext({ pages: [page], eventError: new Error("timeout") }),
        config({ dryRun: false }),
      ),
    ).resolves.toMatchObject({
      signed: false,
      decision: {
        status: "needs_manual_review",
        reason: "Rabby Sign button was not uniquely available",
      },
    });
    expect(page.clickCount).toBe(0);
  });

  test("multiple visible Sign buttons avoid clicking", async () => {
    const page = fakePage({ signButtonCount: 2 });

    await expect(
      signRabbyPopup(
        fakeContext({ pages: [page], eventError: new Error("timeout") }),
        config({ dryRun: false }),
      ),
    ).resolves.toMatchObject({
      signed: false,
      decision: {
        status: "needs_manual_review",
        reason: "Rabby Sign button was not uniquely available",
      },
    });
    expect(page.clickCount).toBe(0);
  });

  test("exactly one approved Sign button clicks once", async () => {
    const page = fakePage({ signButtonCount: 1 });

    await expect(
      signRabbyPopup(
        fakeContext({ pages: [page], eventError: new Error("timeout") }),
        config({ dryRun: false }),
      ),
    ).resolves.toMatchObject({ signed: true });
    expect(page.clickCount).toBe(1);
  });
});
