import { describe, expect, it } from "vitest";

import { evaluateWalletRequest } from "../src/guard.js";
import type { RunnerConfig, WalletRequest } from "../src/types.js";

const config: RunnerConfig = {
  evoevoUrl: "https://evoevo.ai",
  chromeProfilePath: "chrome-profile",
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  maxFeeNative: 0.001,
  allowLearnedActionPattern: false,
  dryRun: true,
  timeoutsMs: {
    pageLoad: 10000,
    popup: 5000,
    signing: 15000,
    feedExpansion: 2000,
  },
  logDir: "logs",
};

function request(overrides: Partial<WalletRequest> = {}): WalletRequest {
  return {
    origin: "https://evoevo.ai",
    chain: "0G",
    contract: "0x61bb710000000000000000000000000000e937f9",
    estimatedFeeNative: 0.0002,
    hasSevereWarning: false,
    actionFingerprint: "add-to-memory",
    rawText: "Simulation Results\n\nevoevo\n\nChain 0G\n\nSign",
    ...overrides,
  };
}

describe("evaluateWalletRequest", () => {
  it("approves matching EvoEvo memory transaction", () => {
    expect(evaluateWalletRequest(request(), config)).toEqual({
      status: "approve",
      reason: "Wallet request matches EvoEvo memory guardrails",
    });
  });

  it("rejects unexpected origin", () => {
    expect(
      evaluateWalletRequest(request({ origin: "https://example.com" }), config),
    ).toEqual({
      status: "reject",
      reason: "Unexpected origin: https://example.com",
    });
  });

  it("requires 0G chain", () => {
    expect(evaluateWalletRequest(request({ chain: "Ethereum" }), config)).toEqual({
      status: "reject",
      reason: "Unexpected chain: Ethereum",
    });
  });

  it("requires whitelisted contract", () => {
    expect(
      evaluateWalletRequest(
        request({ contract: "0x0000000000000000000000000000000000000001" }),
        config,
      ),
    ).toEqual({
      status: "reject",
      reason:
        "Contract is not whitelisted: 0x0000000000000000000000000000000000000001",
    });
  });

  it("pauses when contract is unavailable", () => {
    expect(evaluateWalletRequest(request({ contract: null }), config)).toEqual({
      status: "needs_manual_review",
      reason: "Contract could not be read from wallet popup",
    });
  });

  it("rejects fee above cap", () => {
    expect(
      evaluateWalletRequest(request({ estimatedFeeNative: 0.01 }), config),
    ).toEqual({
      status: "reject",
      reason: "Estimated fee 0.01 exceeds cap 0.001",
    });
  });

  it("pauses on severe warning", () => {
    expect(
      evaluateWalletRequest(request({ hasSevereWarning: true }), config),
    ).toEqual({
      status: "needs_manual_review",
      reason: "Rabby reported a severe warning",
    });
  });

  it("pauses when action fingerprint is unavailable", () => {
    expect(
      evaluateWalletRequest(request({ actionFingerprint: null }), config),
    ).toEqual({
      status: "needs_manual_review",
      reason: "Action fingerprint is unavailable",
    });
  });
});
