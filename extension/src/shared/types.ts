export type GuardStatus = "approve" | "reject" | "needs_manual_review";

export type WalletRequest = {
  origin: string | null;
  chain: string | null;
  contract: string | null;
  value: bigint | null;
  estimatedFeeNative: number | null;
  hasSevereWarning: boolean;
  actionFingerprint: string | null;
  rawText: string | null;
};

export type GuardDecision = {
  status: GuardStatus;
  reason: string;
};

export type ExtensionConfig = {
  allowedOrigin: string;
  allowedChain: string;
  chainId: number;
  rpcUrl: string;
  allowedContracts: string[];
  allowedFunctionSelectors: string[];
  maxFeeNative: number;
  gasPriceJitterPercent: number;
  dryRun: boolean;
  cooldownSeconds: number;
  // Stop automation when each feed tab has fewer than this many
  // unprocessed opinions left. Lets the user leave a buffer rather than
  // draining the feed completely.
  stopAtRemaining: number;
  // Agent id whose feed we automate. All submissions go through this
  // agent. 0 = unset, automation refuses to start.
  agentId: number;
};

export type AttemptStatus =
  | "signed"
  | "skipped"
  | "failed"
  | "manual_review"
  | "dry_run"
  | "rejected"
  | "rejected_origin"
  | "rpc_failed"
  | "reverted";

export type AttemptLog = {
  timestamp: string;
  evoevoUrl: string;
  cardLabel: string | null;
  buttonIndex: number;
  walletRequest: WalletRequest | null;
  decision: GuardDecision | null;
  status: AttemptStatus;
  reason: string;
  txHash: string | null;
};
