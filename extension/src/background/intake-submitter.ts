import { evaluateWalletRequest } from "./guard.js";
import { encodeIntakeReasoning } from "./intake-encoder.js";
import type { ReasoningIntakeWithSig } from "./evoevo-api.js";
import { NonceRetryNeeded, type RpcClient } from "./rpc.js";
import type {
  AttemptLog,
  AttemptStatus,
  ExtensionConfig,
  WalletRequest,
} from "../shared/types.js";

export type TransactionWallet = {
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

export type IntakeSubmitterDeps = {
  config: ExtensionConfig;
  wallet: TransactionWallet;
  rpc: Pick<
    RpcClient,
    | "getTransactionCount"
    | "gasPrice"
    | "estimateGas"
    | "sendRawTransaction"
    | "sendRawTransactionWithNonceRetry"
    | "waitForReceipt"
  >;
  log: { append: (entry: AttemptLog) => Promise<void> };
  random?: () => number;
};

export type SubmitOutcome =
  | { kind: "approved"; txHash: string }
  | { kind: "already_adopted" }
  | { kind: "dry_run" }
  | { kind: "ambiguous"; txHash: string; reason: string }
  | { kind: "rejected"; reason: string; retryable: boolean };

const DEFAULT_FALLBACK_GAS = 400_000n;
const JITTER_SCALE = 10_000n;

export function applyGasPriceJitter(
  baseGasPrice: bigint,
  maxJitterPercent: number,
  random: () => number = Math.random,
): bigint {
  if (maxJitterPercent <= 0) return baseGasPrice;
  const boundedRandom = Math.max(0, Math.min(1, random()));
  const jitterBasisPoints = BigInt(
    Math.floor(boundedRandom * maxJitterPercent * 100),
  );
  return (baseGasPrice * (JITTER_SCALE + jitterBasisPoints)) / JITTER_SCALE;
}

export async function submitIntake(
  payload: ReasoningIntakeWithSig,
  deps: IntakeSubmitterDeps,
): Promise<SubmitOutcome> {
  const { config, wallet, rpc, log } = deps;
  if (wallet.address === null) {
    return { kind: "rejected", reason: "Wallet locked", retryable: false };
  }
  const fromAddress = wallet.address;
  const to = payload.contract_address;
  const data = encodeIntakeReasoning(payload);
  const value = 0n;
  const actionFingerprint = data.slice(0, 10).toLowerCase();
  const nonce = await rpc.getTransactionCount(fromAddress, "pending");
  const baseGasPrice = await rpc.gasPrice();
  const gasPrice = applyGasPriceJitter(
    baseGasPrice,
    config.gasPriceJitterPercent,
    deps.random,
  );

  let gasLimit: bigint;
  try {
    const estimated = await rpc.estimateGas({
      to,
      data,
      value: "0x0",
      from: fromAddress,
    });
    gasLimit = (estimated * 12n) / 10n;
  } catch {
    gasLimit = DEFAULT_FALLBACK_GAS;
  }

  const estimatedFeeNative = Number(gasLimit * gasPrice) / 1e18;
  const walletRequest: WalletRequest = {
    origin: config.allowedOrigin,
    chain: config.allowedChain,
    contract: to,
    value,
    estimatedFeeNative,
    hasSevereWarning: false,
    actionFingerprint,
    rawText: null,
  };
  const decision = evaluateWalletRequest(walletRequest, config);

  if (decision.status !== "approve") {
    const status: AttemptStatus =
      decision.status === "reject" ? "rejected" : "manual_review";
    await log.append(
      makeAttemptLog({ status, reason: decision.reason, walletRequest, decision }),
    );
    return { kind: "rejected", reason: decision.reason, retryable: false };
  }

  if (config.dryRun) {
    await log.append(
      makeAttemptLog({
        status: "dry_run",
        reason: decision.reason,
        walletRequest,
        decision,
      }),
    );
    return { kind: "dry_run" };
  }

  const signed = await wallet.signTransaction({
    to,
    data,
    value,
    nonce,
    gasLimit,
    gasPrice,
    chainId: config.chainId,
  });

  let broadcastTxHash: string;
  try {
    const result = await rpc.sendRawTransactionWithNonceRetry(
      signed,
      fromAddress,
    );
    broadcastTxHash = result.txHash;
  } catch (error) {
    if (!(error instanceof NonceRetryNeeded)) {
      const reason = errorMessage(error);
      await log.append(
        makeAttemptLog({
          status: "rpc_failed",
          reason,
          walletRequest,
          decision,
        }),
      );
      return { kind: "rejected", reason, retryable: true };
    }
    const retrySigned = await wallet.signTransaction({
      to,
      data,
      value,
      nonce: error.refetchedNonce,
      gasLimit,
      gasPrice,
      chainId: config.chainId,
    });
    try {
      broadcastTxHash = await rpc.sendRawTransaction(retrySigned);
    } catch (retryError) {
      const reason = errorMessage(retryError);
      await log.append(
        makeAttemptLog({
          status: "rpc_failed",
          reason,
          walletRequest,
          decision,
        }),
      );
      return { kind: "rejected", reason, retryable: true };
    }
  }

  const receipt = await rpc.waitForReceipt(broadcastTxHash);
  if (receipt === "timeout") {
    await log.append(
      makeAttemptLog({
        status: "rpc_failed",
        reason: `Receipt timeout for ${broadcastTxHash}`,
        walletRequest,
        decision,
        txHash: broadcastTxHash,
      }),
    );
    return {
      kind: "ambiguous",
      txHash: broadcastTxHash,
      reason: "Receipt timeout",
    };
  }
  if (receipt.status === "reverted") {
    await log.append(
      makeAttemptLog({
        status: "reverted",
        reason: "Transaction reverted on-chain",
        walletRequest,
        decision,
        txHash: broadcastTxHash,
      }),
    );
    return {
      kind: "rejected",
      reason: "Reverted on-chain",
      retryable: false,
    };
  }

  await log.append(
    makeAttemptLog({
      status: "signed",
      reason: decision.reason,
      walletRequest,
      decision,
      txHash: broadcastTxHash,
    }),
  );
  return { kind: "approved", txHash: broadcastTxHash };
}

export function makeAttemptLog(
  partial: Partial<AttemptLog> & Pick<AttemptLog, "status" | "reason">,
): AttemptLog {
  return {
    timestamp: new Date().toISOString(),
    evoevoUrl: "https://api.evoevo.ai",
    cardLabel: null,
    buttonIndex: -1,
    walletRequest: partial.walletRequest ?? null,
    decision: partial.decision ?? null,
    status: partial.status,
    reason: partial.reason,
    txHash: partial.txHash ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
