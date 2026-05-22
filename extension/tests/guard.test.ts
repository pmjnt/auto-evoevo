import { describe, it, expect } from "vitest";
import { evaluateWalletRequest } from "../src/background/guard.js";
import type { ExtensionConfig, WalletRequest } from "../src/shared/types.js";

const baseConfig: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
  dryRun: true,
  idleLockMinutes: 30,
};

const baseRequest: WalletRequest = {
  origin: "https://evoevo.ai",
  chain: "0G",
  contract: "0x61bb710000000000000000000000000000e937f9",
  value: 0n,
  estimatedFeeNative: 0.0005,
  hasSevereWarning: false,
  actionFingerprint: "0xd0e30db0",
  rawText: null,
};

describe("guard — ported checks", () => {
  it("approves a fully matching request", () => {
    expect(evaluateWalletRequest(baseRequest, baseConfig).status).toBe("approve");
  });

  it("flags missing origin as needs_manual_review", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, origin: null }, baseConfig).status,
    ).toBe("needs_manual_review");
  });

  it("rejects unexpected origin", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, origin: "https://evil" }, baseConfig).status,
    ).toBe("reject");
  });

  it("rejects unknown contract", () => {
    expect(
      evaluateWalletRequest(
        { ...baseRequest, contract: "0x0000000000000000000000000000000000000000" },
        baseConfig,
      ).status,
    ).toBe("reject");
  });

  it("rejects fee above cap", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, estimatedFeeNative: 0.002 }, baseConfig).status,
    ).toBe("reject");
  });

  it("flags severe warning as needs_manual_review", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, hasSevereWarning: true }, baseConfig).status,
    ).toBe("needs_manual_review");
  });

  it("flags null actionFingerprint as needs_manual_review", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, actionFingerprint: null }, baseConfig).status,
    ).toBe("needs_manual_review");
  });
});

describe("guard — new checks", () => {
  it("rejects when value is non-zero", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, value: 1n }, baseConfig).status,
    ).toBe("reject");
  });

  it("flags null value as needs_manual_review", () => {
    expect(
      evaluateWalletRequest({ ...baseRequest, value: null }, baseConfig).status,
    ).toBe("needs_manual_review");
  });

  it("rejects function selector not in whitelist", () => {
    expect(
      evaluateWalletRequest(
        { ...baseRequest, actionFingerprint: "0xa9059cbb" },
        baseConfig,
      ).status,
    ).toBe("reject");
  });

  it("accepts function selector case-insensitively", () => {
    expect(
      evaluateWalletRequest(
        { ...baseRequest, actionFingerprint: "0xD0E30DB0" },
        baseConfig,
      ).status,
    ).toBe("approve");
  });
});
