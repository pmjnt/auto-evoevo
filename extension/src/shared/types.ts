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
  memoryApiCooldownSeconds: number;
  predictionReadCooldownSeconds: number;
  rateLimitBackoffMinutes: number;
  // Stop automation when each feed tab has fewer than this many
  // unprocessed opinions left. Lets the user leave a buffer rather than
  // draining the feed completely.
  stopAtRemaining: number;
  // Agent id whose feed we automate. All submissions go through this
  // agent. 0 = unset, automation refuses to start.
  agentId: number;
  repeatIntervalMinutes: number;
  reconciliationIntervalMinutes: number;
};

export type WorkflowMode = "feed" | "predictions" | "both";
export type WorkflowName = "feed" | "predictions";
export type WorkflowStatus = "idle" | "running" | "paused" | "error";
export type FeedTabName = "recommended" | "weekly" | "monthly" | "all_time";

export type PredictionActivityEvent =
  | { type: "predictions-loading" }
  | { type: "predictions-sources"; count: number }
  | { type: "predictions-rate-limited"; retryAfterMs: number; sourceAgentId?: number }
  | {
      type: "prediction";
      phase: "submitting" | "confirmed" | "already_adopted" | "skipped" | "failed";
      sourceAgentId: number;
      targetAgentId: number;
      predictionId: string;
      txHash?: string;
      reason?: string;
    };

export type WorkflowCounters = {
  ownedAgents: number;
  feedAgentsCompleted: number;
  sourceAgents: number;
  predictionsScanned: number;
  added: number;
  skipped: number;
  failed: number;
  registryBytes: number;
};

export type RetryItem = {
  predictionId: string;
  opinionId: number;
  sourceAgentId: number;
  targetAgentId: number;
  attempts: number;
  retryAfter: number;
};

export type WorkflowState = {
  version: 1;
  mode: WorkflowMode | null;
  status: WorkflowStatus;
  activeWorkflow: WorkflowName | null;
  nextRunAt: number | null;
  lastIncrementalAt: number | null;
  lastReconciliationAt: number | null;
  feedAgentIndex: number;
  feedTab: FeedTabName | null;
  squareOffset: number;
  sourceAgentIds: number[];
  completedPredictionSourceIds: number[];
  predictionScanStartedAt: number | null;
  predictionOffsets: Record<string, number>;
  retryQueue: RetryItem[];
  blockedPredictionIds: string[];
  counters: WorkflowCounters;
  lastError: string | null;
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
