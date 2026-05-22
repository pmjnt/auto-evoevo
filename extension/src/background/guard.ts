import type { ExtensionConfig, GuardDecision, WalletRequest } from "../shared/types.js";

export function evaluateWalletRequest(
  request: WalletRequest,
  config: ExtensionConfig,
): GuardDecision {
  if (request.origin === null) {
    return { status: "needs_manual_review", reason: "Origin could not be determined" };
  }

  if (request.origin !== config.allowedOrigin) {
    return { status: "reject", reason: `Unexpected origin: ${request.origin}` };
  }

  if (request.chain === null) {
    return { status: "needs_manual_review", reason: "Chain could not be determined" };
  }

  if (request.chain !== config.allowedChain) {
    return { status: "reject", reason: `Unexpected chain: ${request.chain}` };
  }

  if (request.contract === null) {
    return { status: "needs_manual_review", reason: "Contract could not be determined" };
  }

  const normalizedContract = request.contract.toLowerCase();
  const allowedContracts = new Set(
    config.allowedContracts.map((contract) => contract.toLowerCase()),
  );

  if (!allowedContracts.has(normalizedContract)) {
    return { status: "reject", reason: `Contract is not whitelisted: ${request.contract}` };
  }

  if (request.estimatedFeeNative === null) {
    return { status: "needs_manual_review", reason: "Estimated fee could not be determined" };
  }

  if (
    !Number.isFinite(request.estimatedFeeNative) ||
    request.estimatedFeeNative < 0
  ) {
    return { status: "needs_manual_review", reason: "Estimated fee could not be determined" };
  }

  if (request.estimatedFeeNative > config.maxFeeNative) {
    return {
      status: "reject",
      reason: `Estimated fee ${request.estimatedFeeNative} exceeds cap ${config.maxFeeNative}`,
    };
  }

  if (request.hasSevereWarning) {
    return { status: "needs_manual_review", reason: "Severe warning detected" };
  }

  if (request.actionFingerprint === null) {
    return { status: "needs_manual_review", reason: "Action fingerprint is unavailable" };
  }

  return { status: "approve", reason: "Wallet request matches EvoEvo memory guardrails" };
}
