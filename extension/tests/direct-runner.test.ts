import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import {
  applyGasPriceJitter,
  runDirect,
  type DirectAutomationEvent,
} from "../src/background/direct-runner.js";
import {
  EvoEvoApiClient,
  type FeedOpinion,
  type ReasoningIntakeWithSig,
} from "../src/background/evoevo-api.js";
import type { ExtensionConfig, AttemptLog } from "../src/shared/types.js";

const ADDR = "0x373226eb7ec2458a41520d3a375dbf82cc1e1c4c";

const baseConfig: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb71442749d13a4bb7257dfbfff0452ae937f9"],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.01,
  gasPriceJitterPercent: 10,
  dryRun: false,
  cooldownSeconds: 0,
  stopAtRemaining: 0,
  agentId: 8359,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

function intakePayload(opinionId: number): ReasoningIntakeWithSig {
  return {
    chain_id: 16661,
    contract_address: "0x61bb71442749d13a4bb7257dfbfff0452ae937f9",
    method: "intakeReasoningV2",
    identity_registry_address: "0x8004ae533a0301cbd7508373b663756d26dfb028",
    updater: ADDR,
    token_id: "4644",
    source_opinion_id: String(opinionId),
    reasoning_hash: "0x" + "11".repeat(32),
    opinion_hash: "0x" + "22".repeat(32),
    new_memory_root: "0x" + "33".repeat(32),
    nonce: "1",
    deadline: "9999999999",
    expires_at: "2099-01-01T00:00:00Z",
    signature: "0x" + "44".repeat(65),
  };
}

function feedItem(id: number, intaken = false): FeedOpinion {
  return {
    id: String(id),
    type: "reasoning",
    selected_agent_has_intaken: intaken,
    reasoning: { opinion_id: id, selected_agent_has_intaken: intaken },
  };
}

class FakeApi {
  feedByTab: Record<string, FeedOpinion[]> = {};
  intakeCalls: Array<{ agentId: number; opinionId: number }> = [];

  ensureAuth = vi.fn(
    async (
      _address: string,
      signMessage: (message: string) => Promise<string>,
    ) => {
      await signMessage("fake SIWE message");
    },
  );
  isAuthed = (): boolean => true;
  clearAuth = (): void => undefined;
  listAgents = vi.fn(async () => []);
  listFeed = vi.fn(async (args: { tab: string }) => {
    return this.feedByTab[args.tab] ?? [];
  });
  memoryFromOpinion = vi.fn(
    async (agentId: number, opinionId: number) => {
      this.intakeCalls.push({ agentId, opinionId });
      return {
        chain_action: "reasoning_intake_commit",
        memory_id: 100 + opinionId,
        opinion_id: opinionId,
        opinion_hash: "0xab",
        reasoning_hash: "0xcd",
        status: "pending_chain",
        target_agent_id: agentId,
        token_id: "4644",
        reasoning_intake_with_sig: intakePayload(opinionId),
      };
    },
  );
}

function makeWallet() {
  const calls = { signMessage: 0, signTransaction: 0 };
  const wallet: {
    address: string | null;
    signMessage: (message: string) => Promise<string>;
    signTransaction: (tx: unknown) => Promise<string>;
  } = {
    address: ADDR,
    signMessage: vi.fn(async () => {
      calls.signMessage += 1;
      return "0x" + "ab".repeat(65);
    }),
    signTransaction: vi.fn(async () => {
      calls.signTransaction += 1;
      return "0xsigned" + calls.signTransaction;
    }),
  };
  return { calls, wallet };
}

function makeRpc(opts: {
  receiptStatus?: "success" | "reverted" | "timeout";
} = {}) {
  return {
    getTransactionCount: vi.fn(async () => 7),
    gasPrice: vi.fn(async () => 1_000_000_000n),
    estimateGas: vi.fn(async () => 60_000n),
    sendRawTransaction: vi.fn(async () => "0xtx"),
    sendRawTransactionWithNonceRetry: vi.fn(async () => ({
      txHash: "0xtx",
      refetchedNonce: null,
    })),
    waitForReceipt: vi.fn(async () => {
      const status = opts.receiptStatus ?? "success";
      if (status === "timeout") return "timeout" as const;
      return { status, receipt: {} };
    }),
  };
}

function makeLog() {
  const entries: AttemptLog[] = [];
  return {
    entries,
    log: { append: vi.fn(async (e: AttemptLog) => void entries.push(e)) },
  };
}

describe("runDirect", () => {
  beforeEach(() => installFakeChromeApi());

  it("keeps gas price unchanged when jitter is disabled", () => {
    expect(applyGasPriceJitter(1_000_000_000n, 0, () => 0.75)).toBe(
      1_000_000_000n,
    );
  });

  it("applies positive gas price jitter without going below base", () => {
    expect(applyGasPriceJitter(1_000_000_000n, 10, () => 0)).toBe(
      1_000_000_000n,
    );
    expect(applyGasPriceJitter(1_000_000_000n, 10, () => 0.5)).toBe(
      1_050_000_000n,
    );
    expect(applyGasPriceJitter(1_000_000_000n, 10, () => 1)).toBe(
      1_100_000_000n,
    );
  });

  it("authenticates, walks every tab, signs each opinion, emits done", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11), feedItem(12)];
    api.feedByTab.weekly = [feedItem(21)];
    api.feedByTab.monthly = [];
    api.feedByTab.all_time = [];

    const { wallet, calls } = makeWallet();
    const rpc = makeRpc();
    const { log, entries } = makeLog();
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: baseConfig,
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
    });

    expect(api.ensureAuth).toHaveBeenCalledOnce();
    expect(calls.signMessage).toBeGreaterThan(0);
    expect(api.intakeCalls.map((c) => c.opinionId)).toEqual([11, 12, 21]);
    expect(calls.signTransaction).toBe(3);
    expect(entries.filter((e) => e.status === "signed")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("signs with exact RPC gas price when gas jitter is disabled", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11)];
    const { wallet } = makeWallet();
    const rpc = makeRpc();
    const { log } = makeLog();

    await runDirect({
      config: { ...baseConfig, gasPriceJitterPercent: 0 },
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: () => undefined,
      isPaused: () => false,
      random: () => 1,
    });

    expect(wallet.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gasPrice: 1_000_000_000n }),
    );
  });

  it("signs with jittered gas price inside the configured range", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11)];
    const { wallet } = makeWallet();
    const rpc = makeRpc();
    const { log, entries } = makeLog();

    await runDirect({
      config: { ...baseConfig, gasPriceJitterPercent: 10 },
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: () => undefined,
      isPaused: () => false,
      random: () => 0.5,
    });

    expect(wallet.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gasPrice: 1_050_000_000n }),
    );
    expect(entries[0]!.walletRequest!.estimatedFeeNative).toBe(
      Number(72_000n * 1_050_000_000n) / 1e18,
    );
  });

  it("rejects when post-jitter fee exceeds maxFeeNative", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11)];
    const { wallet } = makeWallet();
    const rpc = makeRpc();
    const { log, entries } = makeLog();
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: {
        ...baseConfig,
        maxFeeNative: 0.000075,
        gasPriceJitterPercent: 10,
      },
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
      random: () => 1,
    });

    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(entries[0]!.status).toBe("rejected");
    expect(entries[0]!.walletRequest!.estimatedFeeNative).toBe(
      Number(72_000n * 1_100_000_000n) / 1e18,
    );
    expect(events.at(-1)).toMatchObject({ type: "paused" });
  });
  it("skips opinions the agent has already intaken", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11, true), feedItem(12, false)];

    const { wallet } = makeWallet();
    const rpc = makeRpc();
    const { log, entries } = makeLog();

    await runDirect({
      config: baseConfig,
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: () => undefined,
      isPaused: () => false,
    });

    expect(api.intakeCalls.map((c) => c.opinionId)).toEqual([12]);
    expect(entries.filter((e) => e.status === "signed")).toHaveLength(1);
  });

  it("dry-run logs all opinions but does not sign or broadcast", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11), feedItem(12)];
    api.feedByTab.weekly = [feedItem(21)];

    const { wallet, calls } = makeWallet();
    const rpc = makeRpc();
    const { log, entries } = makeLog();
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: { ...baseConfig, dryRun: true },
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
    });

    expect(calls.signTransaction).toBe(0);
    expect(rpc.sendRawTransactionWithNonceRetry).not.toHaveBeenCalled();
    expect(entries.filter((e) => e.status === "dry_run")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("pauses if wallet is locked", async () => {
    const api = new FakeApi();
    const { wallet } = makeWallet();
    wallet.address = null;
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: baseConfig,
      wallet,
      rpc: makeRpc() as never,
      api: api as unknown as EvoEvoApiClient,
      log: makeLog().log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
    });

    expect(events).toEqual([{ type: "paused", reason: "Wallet locked" }]);
  });

  it("pauses if agentId is unset", async () => {
    const api = new FakeApi();
    const { wallet } = makeWallet();
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: { ...baseConfig, agentId: 0 },
      wallet,
      rpc: makeRpc() as never,
      api: api as unknown as EvoEvoApiClient,
      log: makeLog().log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
    });

    expect(events[0]).toMatchObject({ type: "paused" });
    expect((events[0] as { reason: string }).reason).toMatch(/agentId/);
  });

  it("pauses if a receipt comes back reverted", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = [feedItem(11), feedItem(12)];

    const { wallet } = makeWallet();
    const rpc = makeRpc({ receiptStatus: "reverted" });
    const { log, entries } = makeLog();
    const events: DirectAutomationEvent[] = [];

    await runDirect({
      config: baseConfig,
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: (e) => events.push(e),
      isPaused: () => false,
    });

    expect(api.intakeCalls).toHaveLength(1);
    expect(entries[0]!.status).toBe("reverted");
    expect(events.at(-1)).toMatchObject({ type: "paused" });
  });

  it("stops at the configured remaining threshold", async () => {
    const api = new FakeApi();
    api.feedByTab.recommended = Array.from({ length: 5 }, (_, i) => feedItem(100 + i));
    api.feedByTab.weekly = [];
    api.feedByTab.monthly = [];
    api.feedByTab.all_time = [];

    const { wallet } = makeWallet();
    const rpc = makeRpc();
    const { log } = makeLog();

    await runDirect({
      config: { ...baseConfig, stopAtRemaining: 5 },
      wallet,
      rpc: rpc as never,
      api: api as unknown as EvoEvoApiClient,
      log,
      onEvent: () => undefined,
      isPaused: () => false,
    });

    expect(api.intakeCalls).toHaveLength(0);
  });
});
