import { evaluateWalletRequest } from "./guard.js";
import type {
  AttemptLog,
  AttemptStatus,
  ExtensionConfig,
  WalletRequest,
} from "../shared/types.js";

export type PipelineDeps = {
  wallet: {
    address: string | null;
    signTransaction: (tx: {
      to: string;
      data: string;
      value: bigint;
      nonce: number;
      gasLimit: bigint;
      gasPrice: bigint;
      chainId: number;
    }) => Promise<string>;
  };
  rpc: {
    getTransactionCount: (address: string, tag: "pending") => Promise<number>;
    gasPrice: () => Promise<bigint>;
    sendRawTransactionWithNonceRetry: (
      signed: string,
      fromAddress: string,
    ) => Promise<{ txHash: string; refetchedNonce: number | null }>;
  };
  log: { append: (entry: AttemptLog) => Promise<void> };
};

export type PipelineInput = PipelineDeps & {
  method: string;
  params: unknown[];
  senderOrigin: string;
  config: ExtensionConfig;
};

export type PipelineResult =
  | { ok: true; txHash: string }
  | { ok: false; errorCode: number; reason: string };

const FALLBACK_GAS_LIMIT = 200_000n;

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  if (input.method !== "eth_sendTransaction") {
    return { ok: false, errorCode: 4200, reason: `Unsupported method: ${input.method}` };
  }

  if (input.senderOrigin !== input.config.allowedOrigin) {
    await input.log.append(
      makeLog({ status: "rejected_origin", reason: `Origin mismatch: ${input.senderOrigin}` }),
    );
    return { ok: false, errorCode: 4001, reason: "Origin mismatch" };
  }

  const raw = (input.params[0] ?? {}) as Record<string, unknown>;
  const to = typeof raw.to === "string" ? raw.to : null;
  const dataHex = typeof raw.data === "string" ? raw.data : "0x";
  const valueHex = typeof raw.value === "string" ? raw.value : "0x0";

  const actionFingerprint = dataHex.length >= 10 ? dataHex.slice(0, 10).toLowerCase() : null;

  const value: bigint = ((): bigint => {
    try {
      return BigInt(valueHex);
    } catch {
      return 0n;
    }
  })();

  if (input.wallet.address === null) {
    await input.log.append(makeLog({ status: "failed", reason: "Wallet locked" }));
    return { ok: false, errorCode: 4100, reason: "Wallet locked" };
  }

  const nonce = await input.rpc.getTransactionCount(input.wallet.address, "pending");
  const gasPrice = await input.rpc.gasPrice();
  const estimatedFeeNative = Number(FALLBACK_GAS_LIMIT * gasPrice) / 1e18;

  const walletRequest: WalletRequest = {
    origin: input.senderOrigin,
    chain: input.config.allowedChain,
    contract: to,
    value,
    estimatedFeeNative,
    hasSevereWarning: false,
    actionFingerprint,
    rawText: null,
  };

  const decision = evaluateWalletRequest(walletRequest, input.config);

  if (decision.status !== "approve" || input.config.dryRun) {
    const status: AttemptStatus = input.config.dryRun
      ? "dry_run"
      : decision.status === "reject"
        ? "rejected"
        : "manual_review";
    await input.log.append(makeLog({ status, reason: decision.reason, walletRequest, decision }));
    return { ok: false, errorCode: 4001, reason: decision.reason };
  }

  const signed = await input.wallet.signTransaction({
    to: to as string,
    data: dataHex,
    value,
    nonce,
    gasLimit: FALLBACK_GAS_LIMIT,
    gasPrice,
    chainId: input.config.chainId,
  });

  try {
    const { txHash } = await input.rpc.sendRawTransactionWithNonceRetry(
      signed,
      input.wallet.address,
    );
    await input.log.append(
      makeLog({ status: "signed", reason: decision.reason, walletRequest, decision, txHash }),
    );
    return { ok: true, txHash };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await input.log.append(makeLog({ status: "rpc_failed", reason, walletRequest, decision }));
    return { ok: false, errorCode: 4001, reason };
  }
}

function makeLog(partial: Partial<AttemptLog> & Pick<AttemptLog, "status" | "reason">): AttemptLog {
  return {
    timestamp: new Date().toISOString(),
    evoevoUrl: "",
    cardLabel: null,
    buttonIndex: -1,
    walletRequest: partial.walletRequest ?? null,
    decision: partial.decision ?? null,
    status: partial.status,
    reason: partial.reason,
    txHash: partial.txHash ?? null,
  };
}
