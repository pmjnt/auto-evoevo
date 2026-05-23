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
  // When true, Auto EvoEvo wraps/replaces host wallet providers so
  // eth_sendTransaction can be auto-signed. When false, Rabby/other
  // wallets keep window.ethereum and EIP-6963 announces untouched.
  overrideWalletProvider: boolean;
  // Stop automation when fewer than this many unprocessed ADD TO MEMORY
  // buttons remain visible AND there is no SHOW MORE button to load more.
  stopAtRemaining: number;
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
