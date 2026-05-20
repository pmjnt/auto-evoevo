import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GuardDecision, RunnerConfig, WalletRequest } from "../src/types.js";

const mocks = vi.hoisted(() => {
  const page = {
    url: vi.fn(() => "https://evoevo.ai/feed"),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const controller = {
    openFeed: vi.fn(async () => undefined),
    nextMemoryButton: vi.fn(),
    clickShowMore: vi.fn(),
    clickMemoryButton: vi.fn(async () => undefined),
  };
  const logger = {
    filePath: "logs/session-test.jsonl",
    record: vi.fn(),
    summary: vi.fn(() => ({
      signed: 0,
      skipped: 0,
      failed: 0,
      manual_review: 0,
      dry_run: 1,
    })),
  };

  return {
    page,
    context,
    controller,
    logger,
    launchPersistentContext: vi.fn(async () => context),
    EvoEvoController: vi.fn(() => controller),
    SessionLogger: vi.fn(() => logger),
    signRabbyPopup: vi.fn(),
    consoleLog: vi.spyOn(console, "log").mockImplementation(() => undefined),
    consoleError: vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined),
  };
});

vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: mocks.launchPersistentContext,
  },
}));

vi.mock("../src/evoevo/controller.js", () => ({
  EvoEvoController: mocks.EvoEvoController,
}));

vi.mock("../src/logger.js", () => ({
  SessionLogger: mocks.SessionLogger,
}));

vi.mock("../src/rabby/signer.js", () => ({
  signRabbyPopup: mocks.signRabbyPopup,
}));

const config: RunnerConfig = {
  evoevoUrl: "https://evoevo.ai/feed",
  chromeProfilePath: "chrome-profile",
  rabbyExtensionId: "acmacodkjbdgmoleebolmdjonilkdbch",
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
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
};

const request: WalletRequest = {
  origin: "https://evoevo.ai",
  chain: "0G",
  contract: "0x61bb710000000000000000000000000000e937f9",
  estimatedFeeNative: 0.0001,
  hasSevereWarning: false,
  actionFingerprint: "mint-memory",
  rawText: "Simulation Results",
};

const approvedDecision: GuardDecision = {
  status: "approve",
  reason: "Request passed guard checks",
};

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.page.url.mockReturnValue("https://evoevo.ai/feed");
    mocks.context.pages.mockReturnValue([mocks.page]);
    mocks.logger.summary.mockReturnValue({
      signed: 0,
      skipped: 0,
      failed: 0,
      manual_review: 0,
      dry_run: 1,
    });
  });

  it("opens the feed, signs eligible memory buttons, expands when idle, and closes the context", async () => {
    const { run } = await import("../src/runner.js");
    const button = {
      locator: {},
      index: 3,
      label: "Will Bitcoin reach 87000?",
    };

    mocks.controller.nextMemoryButton
      .mockResolvedValueOnce(button)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mocks.controller.clickShowMore.mockResolvedValue(false);
    mocks.signRabbyPopup.mockResolvedValue({
      request,
      decision: approvedDecision,
      signed: false,
    });

    await run(config);

    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(
      config.chromeProfilePath,
      {
        headless: false,
        channel: "chrome",
      },
    );
    expect(mocks.EvoEvoController).toHaveBeenCalledWith(mocks.page, config);
    expect(mocks.controller.openFeed).toHaveBeenCalled();
    expect(mocks.controller.clickMemoryButton).toHaveBeenCalledWith(button);
    expect(mocks.signRabbyPopup).toHaveBeenCalledWith(mocks.context, config);
    expect(mocks.logger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        evoevoUrl: "https://evoevo.ai/feed",
        cardLabel: "Will Bitcoin reach 87000?",
        buttonIndex: 3,
        walletRequest: request,
        decision: approvedDecision,
        status: "dry_run",
        reason: "Dry run",
      }),
    );
    expect(mocks.controller.clickShowMore).toHaveBeenCalledTimes(2);
    expect(mocks.context.close).toHaveBeenCalled();
  });

  it("records failed attempts and stops the session when signing throws", async () => {
    const { run } = await import("../src/runner.js");
    const button = {
      locator: {},
      index: 0,
      label: null,
    };

    mocks.controller.nextMemoryButton.mockResolvedValue(button);
    mocks.signRabbyPopup.mockRejectedValue(new Error("Popup timeout"));

    await run(config);

    expect(mocks.logger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        cardLabel: null,
        buttonIndex: 0,
        walletRequest: null,
        decision: null,
        status: "failed",
        reason: "Popup timeout",
      }),
    );
    expect(mocks.context.close).toHaveBeenCalled();
  });
});
