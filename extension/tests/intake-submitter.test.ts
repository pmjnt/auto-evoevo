import { describe, expect, it, vi } from "vitest";
import {
  applyGasPriceJitter,
  submitIntake,
} from "../src/background/intake-submitter.js";
import type { ReasoningIntakeWithSig } from "../src/background/evoevo-api.js";
import type { AttemptLog, ExtensionConfig } from "../src/shared/types.js";

const config: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb71442749d13a4bb7257dfbfff0452ae937f9"],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.01,
  gasPriceJitterPercent: 0,
  dryRun: false,
  cooldownSeconds: 0,
  stopAtRemaining: 0,
  agentId: 1,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

const payload: ReasoningIntakeWithSig = {
  chain_id: 16661,
  contract_address: config.allowedContracts[0]!,
  method: "intakeReasoningV2",
  identity_registry_address: "0x8004Ae533a0301CbD7508373b663756D26DfB028",
  updater: "0x" + "11".repeat(20),
  token_id: "1",
  source_opinion_id: "10",
  reasoning_hash: "0x" + "22".repeat(32),
  opinion_hash: "0x" + "33".repeat(32),
  new_memory_root: "0x" + "44".repeat(32),
  nonce: "1",
  deadline: "9999999999",
  expires_at: "3026-01-01T00:00:00Z",
  signature: "0x1234",
};

function deps(
  receipt:
    | "timeout"
    | { status: "success" | "reverted"; receipt: unknown } = {
    status: "success",
    receipt: {},
  },
) {
  const entries: AttemptLog[] = [];
  return {
    entries,
    value: {
      config,
      wallet: {
        address: payload.updater,
        signTransaction: vi.fn(async () => "0xsigned"),
      },
      rpc: {
        getTransactionCount: vi.fn(async () => 1),
        gasPrice: vi.fn(async () => 1_000_000_000n),
        estimateGas: vi.fn(async () => 72_000n),
        sendRawTransactionWithNonceRetry: vi.fn(async () => ({
          txHash: "0xtx",
          refetchedNonce: null,
        })),
        sendRawTransaction: vi.fn(async () => "0xtx"),
        waitForReceipt: vi.fn(async () => receipt),
      },
      log: { append: async (entry: AttemptLog) => { entries.push(entry); } },
    },
  };
}

describe("intake submitter", () => {
  it("applies bounded gas jitter", () => {
    expect(applyGasPriceJitter(100n, 10, () => 0.5)).toBe(105n);
  });

  it("approves only after a successful receipt", async () => {
    const setup = deps();
    await expect(submitIntake(payload, setup.value)).resolves.toEqual({
      kind: "approved",
      txHash: "0xtx",
    });
    expect(setup.entries.at(-1)?.status).toBe("signed");
  });

  it("returns ambiguous with the hash on receipt timeout", async () => {
    const setup = deps("timeout");
    await expect(submitIntake(payload, setup.value)).resolves.toEqual({
      kind: "ambiguous",
      txHash: "0xtx",
      reason: "Receipt timeout",
    });
  });

  it("returns dry_run without signing", async () => {
    const setup = deps();
    await expect(submitIntake(payload, {
      ...setup.value,
      config: { ...config, dryRun: true },
    })).resolves.toEqual({ kind: "dry_run" });
    expect(setup.value.wallet.signTransaction).not.toHaveBeenCalled();
  });
});
