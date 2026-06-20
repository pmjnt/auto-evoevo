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

import {
  EvoEvoApiClient,
  EvoEvoAuthError,
  FEED_TABS,
  type FeedOpinion,
  type ReasoningIntakeWithSig,
} from "./evoevo-api.js";
import type { RpcClient } from "./rpc.js";
import {
  makeAttemptLog,
  submitIntake,
  type TransactionWallet,
} from "./intake-submitter.js";
import type { AttemptLog, ExtensionConfig } from "../shared/types.js";

export { applyGasPriceJitter } from "./intake-submitter.js";

export type DirectAutomationEvent =
  | { type: "started" }
  | { type: "tab"; tab: string }
  | { type: "fetched"; tab: string; count: number }
  | { type: "approved"; txHash: string }
  | { type: "paused"; reason: string }
  | { type: "done" };

export type WalletShape = TransactionWallet & {
  signMessage: (message: string) => Promise<string>;
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
  random?: () => number;
};

export type RunnerResult =
  | { kind: "completed" }
  | { kind: "paused" }
  | { kind: "failed"; reason: string; global: boolean };

export async function runDirect(deps: DirectRunnerDeps): Promise<void> {
  await runFeedForAgent(deps, deps.config.agentId);
}

export async function runFeedForAgent(
  deps: DirectRunnerDeps,
  agentId: number,
): Promise<RunnerResult> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (deps.wallet.address === null) {
    deps.onEvent({ type: "paused", reason: "Wallet locked" });
    return { kind: "failed", reason: "Wallet locked", global: true };
  }
  if (!agentId || agentId <= 0) {
    deps.onEvent({
      type: "paused",
      reason: "agentId not configured (Options > Active agent)",
    });
    return { kind: "failed", reason: "agentId not configured", global: false };
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
    return { kind: "failed", reason: `SIWE failed: ${errorMessage(error)}`, global: true };
  }

  const cooldownMs = Math.max(0, deps.config.cooldownSeconds) * 1000;
  const stopAtRemaining = Math.max(0, deps.config.stopAtRemaining);

  for (const tab of FEED_TABS) {
    if (deps.isPaused()) {
      deps.onEvent({ type: "paused", reason: "Paused by user" });
      return { kind: "paused" };
    }
    deps.onEvent({ type: "tab", tab });

    let feed: FeedOpinion[];
    try {
      feed = await deps.api.listFeed({
        tab,
        chainId: deps.config.chainId,
        agentId,
        limit: 100,
      });
    } catch (error) {
      if (error instanceof EvoEvoAuthError) {
        deps.onEvent({
          type: "paused",
          reason: "EvoEvo auth rejected — unlock + start again",
        });
        return { kind: "failed", reason: "EvoEvo auth rejected", global: true };
      }
      deps.onEvent({
        type: "paused",
        reason: `Feed fetch failed (${tab}): ${errorMessage(error)}`,
      });
      return { kind: "failed", reason: `Feed fetch failed (${tab})`, global: true };
    }

    deps.onEvent({ type: "fetched", tab, count: feed.length });

    if (feed.length === 0) continue;
    if (stopAtRemaining > 0 && feed.length <= stopAtRemaining) continue;

    for (const opinion of feed) {
      if (deps.isPaused()) {
        deps.onEvent({ type: "paused", reason: "Paused by user" });
        return { kind: "paused" };
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
          agentId,
          opinionId,
        );
        payload = response.reasoning_intake_with_sig;
      } catch (error) {
        if (error instanceof EvoEvoAuthError) {
          deps.onEvent({
            type: "paused",
            reason: "EvoEvo auth rejected mid-loop",
          });
          return { kind: "failed", reason: "EvoEvo auth rejected mid-loop", global: true };
        }
        await deps.log.append(
          makeAttemptLog({
            status: "skipped",
            reason: `from-opinion ${opinionId}: ${errorMessage(error)}`,
          }),
        );
        continue;
      }

      const outcome = await submitIntake(payload, deps);

      if (outcome.kind === "approved") {
        deps.onEvent({ type: "approved", txHash: outcome.txHash });
        if (cooldownMs > 0) await sleep(cooldownMs);
        continue;
      }

      if (outcome.kind === "dry_run") {
        if (cooldownMs > 0) await sleep(cooldownMs);
        continue;
      }

      // Hard failure (reverted, rpc_failed, guard reject): stop the loop.
      deps.onEvent({ type: "paused", reason: outcome.reason });
        return { kind: "failed", reason: outcome.reason, global: outcome.kind === "ambiguous" };
    }
  }

  deps.onEvent({ type: "done" });
  return { kind: "completed" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
