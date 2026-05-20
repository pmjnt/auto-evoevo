export type GuardStatus = "approve" | "reject" | "needs_manual_review";

export type WalletRequest = {
  origin: string | null;
  chain: string | null;
  contract: string | null;
  estimatedFeeNative: number | null;
  hasSevereWarning: boolean;
  actionFingerprint: string | null;
  rawText: string;
};

export type GuardDecision = {
  status: GuardStatus;
  reason: string;
};

export type RunnerConfig = {
  evoevoUrl: string;
  chromeProfilePath: string;
  allowedOrigin: string;
  allowedChain: string;
  allowedContracts: string[];
  maxFeeNative: number;
  allowLearnedActionPattern: boolean;
  dryRun: boolean;
  timeoutsMs: {
    pageLoad: number;
    popup: number;
    signing: number;
    feedExpansion: number;
  };
  logDir: string;
};

export type AttemptStatus =
  | "signed"
  | "skipped"
  | "failed"
  | "manual_review"
  | "dry_run";

export type AttemptLog = {
  timestamp: string;
  evoevoUrl: string;
  cardLabel: string | null;
  buttonIndex: number;
  walletRequest: WalletRequest | null;
  decision: GuardDecision | null;
  status: AttemptStatus;
  reason: string;
};
