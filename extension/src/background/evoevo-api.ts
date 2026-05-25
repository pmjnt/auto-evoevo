// Thin REST client for EvoEvo's public API. Auth via Bearer JWT.
// All endpoints reverse-engineered from a real session HAR. See
// docs/superpowers/specs/2026-05-25-direct-contract-design.md.

import { siweLogin, type SiweAuth } from "./siwe.js";

const DEFAULT_BASE = "https://api.evoevo.ai";

// The /v1/platform/feeding endpoint accepts these tab buckets. The
// user-facing automation cycles through them in this order until
// every bucket is exhausted.
export const FEED_TABS = ["recommended", "weekly", "monthly", "all_time"] as const;
export type FeedTab = (typeof FEED_TABS)[number];

export type OnchainIdentity = {
  agent_uri: string;
  agent_wallet_address: string;
  chain_id: number;
  identity_agent_id: string; // used as the on-chain tokenId
  status: string;
};

export type Agent = {
  id: number;
  name: string;
  onchain_identity: OnchainIdentity | null;
  active: boolean;
};

export type FeedOpinion = {
  id: string;
  type: string;
  reasoning?: { opinion_id: number; selected_agent_has_intaken: boolean };
  selected_agent_has_intaken?: boolean;
};

export type ReasoningIntakeWithSig = {
  chain_id: number;
  contract_address: string;
  method: "intakeReasoning";
  updater: string;
  token_id: string;
  source_opinion_id: string;
  reasoning_hash: string;
  opinion_hash: string;
  new_memory_root: string;
  nonce: string;
  deadline: string;
  expires_at: string;
  signature: string;
};

export type FromOpinionResponse = {
  chain_action: string;
  memory_id: number;
  opinion_id: number;
  reasoning_intake_with_sig: ReasoningIntakeWithSig;
  status: string;
  target_agent_id: number;
  token_id: string;
};

export type ApiOptions = {
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

export class EvoEvoApiClient {
  private auth: SiweAuth | null = null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  isAuthed(): boolean {
    if (this.auth === null) return false;
    const expiresMs = Date.parse(this.auth.expiresAt);
    // Re-auth a minute before expiry to avoid races on long-running loops.
    return Number.isFinite(expiresMs) && Date.now() < expiresMs - 60_000;
  }

  async ensureAuth(
    address: string,
    signMessage: (message: string) => Promise<string>,
  ): Promise<void> {
    if (this.isAuthed()) return;
    this.auth = await siweLogin(address, signMessage, {
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
    });
  }

  clearAuth(): void {
    this.auth = null;
  }

  // GET /v1/agents?wallet_address=...&chain_id=...
  async listAgents(walletAddress: string, chainId: number): Promise<Agent[]> {
    const url = `${this.baseUrl}/v1/agents?wallet_address=${walletAddress}&chain_id=${chainId}`;
    return await this.requestJson<Agent[]>("GET", url);
  }

  // GET /v1/platform/feeding?tab=...&limit=20&chain_id=...&agent_id=...&include_intaken=false
  async listFeed(args: {
    tab: FeedTab;
    chainId: number;
    agentId: number;
    limit?: number;
    includeIntaken?: boolean;
  }): Promise<FeedOpinion[]> {
    const params = new URLSearchParams({
      tab: args.tab,
      limit: String(args.limit ?? 20),
      chain_id: String(args.chainId),
      agent_id: String(args.agentId),
      include_intaken: String(args.includeIntaken ?? false),
    });
    return await this.requestJson<FeedOpinion[]>(
      "GET",
      `${this.baseUrl}/v1/platform/feeding?${params.toString()}`,
    );
  }

  // POST /v1/agents/{agentId}/memories/from-opinion
  async memoryFromOpinion(
    agentId: number,
    opinionId: number,
  ): Promise<FromOpinionResponse> {
    return await this.requestJson<FromOpinionResponse>(
      "POST",
      `${this.baseUrl}/v1/agents/${agentId}/memories/from-opinion`,
      { opinion_id: opinionId },
    );
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<T> {
    if (this.auth === null) {
      throw new Error("EvoEvoApiClient not authenticated (call ensureAuth first)");
    }
    const response = await this.fetchFn(url, {
      method,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        authorization: `Bearer ${this.auth.token}`,
        origin: "https://evoevo.ai",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      this.auth = null;
      throw new EvoEvoAuthError(`Unauthorized: ${url}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `EvoEvo API ${method} ${url} -> ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  }
}

export class EvoEvoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvoEvoAuthError";
  }
}
