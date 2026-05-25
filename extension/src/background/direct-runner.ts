// Direct-mode automation loop. Runs entirely in the service worker:
//   SIWE login -> JWT
//   for each feed tab in (recommended, weekly, monthly, all_time):
//     GET /v1/platform/feeding (incl. include_intaken=false)
//     for each opinion:
//       POST .../memories/from-opinion -> backend-signed payload
//       guard check + sign + broadcast + wait receipt
//
// No DOM access, no evoevo.ai tab required. Reuses guard, wallet, RPC,
// session log and the receipt-wait logic from the existing pipeline.

import { evaluateWalletRequest } from "./guard.js";
import { encodeIntakeReasoning } from "./intake-encoder.js";
import {
  EvoEvoApiClient,
  EvoEvoAuthError,
  FEED_TABS,
  type FeedOpinion,
  type ReasoningIntakeWithSig,
} from "./evoevo-api.js";
import { NonceRetryNeeded, type RpcClient } from "./rpc.js";
import type {
  AttemptLog,
  AttemptStatus,
  ExtensionConfig,
  WalletRequest,
} from "../shared/types.js";

export type DirectAutomationEvent =
  | { type: "started" }
  | { type: "tab"; tab: string }
  | { type: "fetched"; tab: string; count: number }
  | { type: "approved"; txHash: string }
  | { type: "paused"; reason: string }
  | { type: "done" };

export type WalletShape = {
  address: string | null;
  signMessage: (message: string) => Promise<string>;
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

export type DirectRunnerDeps = {
  config: ExtensionConfig;
  wallet: WalletShape;
  rpc: Pick<
    RpcClient,
    | "getTransactionCount"
    | "gasPrice"
    | "estimateGas"
    | "sendRawTransaction"
    | "sendRawTransactionWithNonceRetry"
    | "waitForReceipt"
  >;
  api: EvoEvoApiClient;
  log: { append: (entry: AttemptLog) => Promise<void> };
  onEvent: (event: DirectAutomationEvent) => void;
  isPaused: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_FALLBACK_GAS = 400_000n;

export async function runDirect(deps: DirectRunnerDeps): Promise<void> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (deps.wallet.address === null) {
    deps.onEvent({ type: "paused", reason: "Wallet locked" });
    return;
  }
  if (!deps.config.agentId || deps.config.agentId <= 0) {
    deps.onEvent({
      type: "paused",
      reason: "agentId not configured (Options > Active agent)",
    });
    return;
  }

  deps.onEvent({ type: "started" });

  try {
    await deps.api.ensureAuth(deps.wallet.address, (msg) =>
      deps.wallet.signMessage(msg),
    );
  } catch (error) {
    deps.onEvent({
      type: "paused",
      reason: `SIWE failed: ${errorMessage(error)}`,
    });
    return;
  }

  const cooldownMs = Math.max(0, deps.config.cooldownSeconds) * 1000;
  const stopAtRemaining = Math.max(0, deps.config.stopAtRemaining);

  for (const tab of FEED_TABS) {
    if (deps.isPaused()) {
      deps.onEvent({ type: "paused", reason: "Paused by user" });
      return;
    }
    deps.onEvent({ type: "tab", tab });

    let feed: FeedOpinion[];
    try {
      feed = await deps.api.listFeed({
        tab,
        chainId: deps.config.chainId,
        agentId: deps.config.agentId,
      });
    } catch (error) {
      if (error instanceof EvoEvoAuthError) {
        deps.onEvent({
          type: "paused",
          reason: "EvoEvo auth rejected — unlock + start again",
        });
        return;
      }
      deps.onEvent({
        type: "paused",
        reason: `Feed fetch failed (${tab}): ${errorMessage(error)}`,
      });
      return;
    }

    deps.onEvent({ type: "fetched", tab, count: feed.length });

    if (feed.length === 0) continue;
    if (stopAtRemaining > 0 && feed.length <= stopAtRemaining) continue;

    for (const opinion of feed) {
      if (deps.isPaused()) {
        deps.onEvent({ type: "paused", reason: "Paused by user" });
        return;
      }

      const opinionId = Number.parseInt(opinion.id, 10);
      if (!Number.isFinite(opinionId)) continue;
      if (
        opinion.selected_agent_has_intaken === true ||
        opinion.reasoning?.selected_agent_has_intaken === true
      ) {
        continue;
      }

      let payload: ReasoningIntakeWithSig;
      try {
        const response = await deps.api.memoryFromOpinion(
          deps.config.agentId,
          opinionId,
        );
        payload = response.reasoning_intake_with_sig;
      } catch (error) {
        if (error instanceof EvoEvoAuthError) {
          deps.onEvent({
            type: "paused",
            reason: "EvoEvo auth rejected mid-loop",
          });
          return;
        }
        // Skip this opinion; backend may have rejected (already intaken, etc.).
        await deps.log.append(
          makeLog({
            status: "skipped",
            reason: `from-opinion ${opinionId}: ${errorMessage(error)}`,
          }),
        );
        continue;
      }

      const outcome = await submitIntake({
        payload,
        deps,
      });

      if (outcome.kind === "approved") {
        deps.onEvent({ type: "approved", txHash: outcome.txHash });
        if (cooldownMs > 0) await sleep(cooldownMs);
        continue;
      }

      // Non-approve: pause the whole loop.
      deps.onEvent({ type: "paused", reason: outcome.reason });
      return;
    }
  }

  deps.onEvent({ type: "done" });
}

type SubmitOutcome =
  | { kind: "approved"; txHash: string }
  | { kind: "rejected"; reason: string };

async function submitIntake(args: {
  payload: ReasoningIntakeWithSig;
  deps: DirectRunnerDeps;
}): Promise<SubmitOutcome> {
  const { payload, deps } = args;
  const { config, wallet, rpc, log } = deps;
  const fromAddress = wallet.address as string;

  const to = payload.contract_address;
  const data = encodeIntakeReasoning(payload);
  const value = 0n;
  const actionFingerprint = data.slice(0, 10).toLowerCase();

  // Pre-fetch nonce + gas before guard so estimatedFeeNative is honest.
  const nonce = await rpc.getTransactionCount(fromAddress, "pending");
  const gasPrice = await rpc.gasPrice();

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

  if (decision.status !== "approve" || config.dryRun) {
    const status: AttemptStatus = config.dryRun
      ? "dry_run"
      : decision.status === "reject"
        ? "rejected"
        : "manual_review";
    await log.append(
      makeLog({
        status,
        reason: decision.reason,
        walletRequest,
        decision,
      }),
    );
    return { kind: "rejected", reason: decision.reason };
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
        makeLog({
          status: "rpc_failed",
          reason,
          walletRequest,
          decision,
        }),
      );
      return { kind: "rejected", reason };
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
    } catch (retryErr) {
      const reason = errorMessage(retryErr);
      await log.append(
        makeLog({
          status: "rpc_failed",
          reason,
          walletRequest,
          decision,
        }),
      );
      return { kind: "rejected", reason };
    }
  }

  const receipt = await rpc.waitForReceipt(broadcastTxHash);
  if (receipt === "timeout") {
    await log.append(
      makeLog({
        status: "rpc_failed",
        reason: `Receipt timeout for ${broadcastTxHash}`,
        walletRequest,
        decision,
        txHash: broadcastTxHash,
      }),
    );
    return { kind: "rejected", reason: "Receipt timeout" };
  }
  if (receipt.status === "reverted") {
    await log.append(
      makeLog({
        status: "reverted",
        reason: "Transaction reverted on-chain",
        walletRequest,
        decision,
        txHash: broadcastTxHash,
      }),
    );
    return { kind: "rejected", reason: "Reverted on-chain" };
  }

  await log.append(
    makeLog({
      status: "signed",
      reason: decision.reason,
      walletRequest,
      decision,
      txHash: broadcastTxHash,
    }),
  );
  return { kind: "approved", txHash: broadcastTxHash };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeLog(
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
