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
  dryRun: boolean;
  idleLockMinutes: number;
  cooldownSeconds: number;
  // Stop automation when fewer than this many unprocessed ADD TO MEMORY
  // buttons remain visible AND there is no SHOW MORE button to load more.
  stopAtRemaining: number;
  // "dom"    = automate by clicking ADD TO MEMORY buttons on evoevo.ai
  // "direct" = skip the page entirely, call EvoEvo's REST API + contract
  //            directly from the service worker
  runMode: "dom" | "direct";
  // Agent id to operate as in direct mode. Single value because all
  // submissions share one wallet identity. 0 = unset.
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
