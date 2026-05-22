import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { runPipeline } from "../src/background/pipeline.js";
import type { ExtensionConfig, AttemptLog } from "../src/shared/types.js";

const config: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://rpc.example",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
  dryRun: false,
  idleLockMinutes: 30,
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const signed: string[] = [];
  const broadcasted: string[] = [];
  const logged: AttemptLog[] = [];

  return {
    signed,
    broadcasted,
    logged,
    deps: {
      wallet: {
        address: "0xfrom",
        signTransaction: vi.fn(async (tx: any) => {
          signed.push(JSON.stringify(tx, replacer));
          return "0xsigned";
        }),
      },
      rpc: {
        getTransactionCount: vi.fn(async () => 7),
        gasPrice: vi.fn(async () => 1_000_000_000n),
        sendRawTransactionWithNonceRetry: vi.fn(async (raw: string) => {
          broadcasted.push(raw);
          return { txHash: "0xtx", refetchedNonce: null };
        }),
      },
      log: {
        append: vi.fn(async (entry: AttemptLog) => {
          logged.push(entry);
        }),
      },
      ...overrides,
    },
  };
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("pipeline.runPipeline", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  const params = {
    to: "0x61bb710000000000000000000000000000e937f9",
    data: "0xd0e30db0",
    value: "0x0",
  };

  it("approves + signs + broadcasts a valid request", async () => {
    const { deps, signed, broadcasted, logged } = makeDeps();
    const result = await runPipeline({
      method: "eth_sendTransaction",
      params: [params],
      senderOrigin: "https://evoevo.ai",
      config,
      ...deps,
    } as any);
    expect(result.ok).toBe(true);
    expect((result as any).txHash).toBe("0xtx");
    expect(signed).toHaveLength(1);
    expect(broadcasted).toEqual(["0xsigned"]);
    expect(logged[0]!.status).toBe("signed");
  });

  it("rejects when origin mismatches without consulting guard or wallet", async () => {
    const { deps, signed, broadcasted, logged } = makeDeps();
    const result = await runPipeline({
      method: "eth_sendTransaction",
      params: [params],
      senderOrigin: "https://evil.com",
      config,
      ...deps,
    } as any);
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe(4001);
    expect(signed).toHaveLength(0);
    expect(broadcasted).toHaveLength(0);
    expect(logged[0]!.status).toBe("rejected_origin");
  });

  it("rejects when guard rejects (contract not whitelisted) and does not sign", async () => {
    const { deps, signed, logged } = makeDeps();
    const result = await runPipeline({
      method: "eth_sendTransaction",
      params: [{ ...params, to: "0x" + "00".repeat(20) }],
      senderOrigin: "https://evoevo.ai",
      config,
      ...deps,
    } as any);
    expect(result.ok).toBe(false);
    expect(signed).toHaveLength(0);
    expect(logged[0]!.status).toBe("rejected");
  });

  it("does not sign when dryRun is true even on approve", async () => {
    const { deps, signed, broadcasted, logged } = makeDeps();
    const result = await runPipeline({
      method: "eth_sendTransaction",
      params: [params],
      senderOrigin: "https://evoevo.ai",
      config: { ...config, dryRun: true },
      ...deps,
    } as any);
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe(4001);
    expect(signed).toHaveLength(0);
    expect(broadcasted).toHaveLength(0);
    expect(logged[0]!.status).toBe("dry_run");
  });

  it("logs manual_review for needs_manual_review guard outcome", async () => {
    const { deps, logged } = makeDeps();
    const result = await runPipeline({
      method: "eth_sendTransaction",
      params: [{ ...params, data: "0x" }],
      senderOrigin: "https://evoevo.ai",
      config,
      ...deps,
    } as any);
    expect(result.ok).toBe(false);
    expect(logged[0]!.status).toBe("manual_review");
  });
});
