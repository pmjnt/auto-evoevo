import type { GuardDecision, RunnerConfig, WalletRequest } from "./types.js";

export function evaluateWalletRequest(
  request: WalletRequest,
  config: RunnerConfig,
): GuardDecision {
  if (request.origin !== config.allowedOrigin) {
    return {
      status: "reject",
      reason: `Unexpected origin: ${request.origin}`,
    };
  }

  if (request.chain !== config.allowedChain) {
    return {
      status: "reject",
      reason: `Unexpected chain: ${request.chain}`,
    };
  }

  if (request.contract === null) {
    return {
      status: "needs_manual_review",
      reason: "Contract could not be read from wallet popup",
    };
  }

  const normalizedContract = request.contract.toLowerCase();
  const allowedContracts = new Set(
    config.allowedContracts.map((contract) => contract.toLowerCase()),
  );

  if (!allowedContracts.has(normalizedContract)) {
    return {
      status: "reject",
      reason: `Contract is not whitelisted: ${request.contract}`,
    };
  }

  if (request.estimatedFeeNative === null) {
    return {
      status: "needs_manual_review",
      reason: "Estimated fee is unavailable",
    };
  }

  if (request.estimatedFeeNative > config.maxFeeNative) {
    return {
      status: "reject",
      reason: `Estimated fee ${request.estimatedFeeNative} exceeds cap ${config.maxFeeNative}`,
    };
  }

  if (request.hasSevereWarning) {
    return {
      status: "needs_manual_review",
      reason: "Rabby reported a severe warning",
    };
  }

  if (
    request.actionFingerprint === null &&
    !config.allowLearnedActionPattern
  ) {
    return {
      status: "needs_manual_review",
      reason: "Action fingerprint is unavailable",
    };
  }

  return {
    status: "approve",
    reason: "Wallet request matches EvoEvo memory guardrails",
  };
}
