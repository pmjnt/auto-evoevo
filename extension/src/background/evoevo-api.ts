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
  method: "intakeReasoningV2";
  identity_registry_address: string;
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

export type PageRequest = { cursor?: string; before?: number };
export type ApiPage<T> = {
  items: T[];
  next: PageRequest | null;
  fingerprint: string;
};

export type SquareAgent = { id: number; name: string };
export type AgentPrediction = {
  predictionId: string;
  opinionId: number;
  createdAt: string;
  viewerHasIntaken: boolean;
};

// Allows the EvoEvoApiClient to persist its JWT outside of instance
// memory. Production wires this to chrome.storage.session so the token
// survives service-worker restarts but is cleared when Chrome closes.
export type TokenStorage = {
  load: () => Promise<SiweAuth | null>;
  save: (auth: SiweAuth) => Promise<void>;
  clear: () => Promise<void>;
};

export type ApiOptions = {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  tokenStorage?: TokenStorage;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export class EvoEvoApiClient {
  private auth: SiweAuth | null = null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly tokenStorage: TokenStorage | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private authContext: {
    address: string;
    signMessage: (message: string) => Promise<string>;
  } | null = null;

  constructor(options: ApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.tokenStorage = options.tokenStorage ?? null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
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
    this.authContext = { address, signMessage };
    // Rehydrate from persistent storage if we don't have a live token.
    // Lets the loop survive a service-worker restart without forcing
    // the user to unlock + re-sign the SIWE message.
    if (this.auth === null && this.tokenStorage !== null) {
      const stored = await this.tokenStorage.load();
      if (stored !== null && stored.address.toLowerCase() === address.toLowerCase()) {
        this.auth = stored;
      }
    }
    if (this.isAuthed()) return;

    this.auth = await siweLogin(address, signMessage, {
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
    });
    if (this.tokenStorage !== null) {
      await this.tokenStorage.save(this.auth);
    }
  }

  async clearAuth(): Promise<void> {
    this.auth = null;
    if (this.tokenStorage !== null) {
      await this.tokenStorage.clear();
    }
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

  async listSquareAgents(args: {
    chainId: number;
    limit?: number;
    cursor?: string;
  }): Promise<ApiPage<SquareAgent>> {
    const params = new URLSearchParams({
      limit: String(args.limit ?? 20),
      status: "all",
      min_settled_predictions: "3",
      type: "agent",
      chain_id: String(args.chainId),
    });
    if (args.cursor) params.set("cursor", args.cursor);
    const raw = await this.requestJson<unknown>(
      "GET",
      `${this.baseUrl}/v1/square/feed?${params.toString()}`,
    );
    return normalizeSquarePage(raw);
  }

  async listAgentPredictions(args: {
    sourceAgentId: number;
    chainId: number;
    limit?: number;
    before?: number;
  }): Promise<ApiPage<AgentPrediction>> {
    const limit = args.limit ?? 20;
    const params = new URLSearchParams({
      limit: String(limit),
      chain_id: String(args.chainId),
    });
    if (args.before !== undefined) params.set("before", String(args.before));
    const raw = await this.requestJson<unknown>(
      "GET",
      `${this.baseUrl}/v1/agents/${args.sourceAgentId}/predictions?${params.toString()}`,
    );
    return normalizePredictionsPage(raw, limit);
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
    let transientRetries = 0;
    let reauthenticated = false;
    while (true) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers: {
            accept: "*/*",
            "content-type": "application/json",
            authorization: `Bearer ${this.auth?.token ?? ""}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (transientRetries < 3) {
          await this.waitForRetry(transientRetries++);
          continue;
        }
        throw new EvoEvoHttpError(
          `EvoEvo API ${method} ${url} network failure: ${error instanceof Error ? error.message : String(error)}`,
          null,
          true,
        );
      }

      if (response.status === 401) {
        if (!reauthenticated && this.authContext !== null) {
          reauthenticated = true;
          await this.clearAuth();
          await this.ensureAuth(
            this.authContext.address,
            this.authContext.signMessage,
          );
          continue;
        }
        await this.clearAuth();
        throw new EvoEvoAuthError(`Unauthorized: ${url}`);
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && transientRetries < 3) {
        await this.waitForRetry(transientRetries++);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const responseBody = parseErrorBody(text);
        throw new EvoEvoHttpError(
          `EvoEvo API ${method} ${url} -> ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
          response.status,
          retryable,
          responseBody,
        );
      }
      return (await response.json()) as T;
    }
  }

  private async waitForRetry(attempt: number): Promise<void> {
    const base = Math.min(30_000, 500 * 2 ** attempt);
    await this.sleep(base + Math.floor(base * 0.25 * this.random()));
  }
}

export class EvoEvoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvoEvoAuthError";
  }
}

export class EvoEvoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly responseBody: unknown = null,
  ) {
    super(message);
    this.name = "EvoEvoHttpError";
  }
}

export function isAlreadyAdoptedError(error: unknown): boolean {
  if (!(error instanceof EvoEvoHttpError) || error.status !== 409) return false;
  const body = error.responseBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>)["error"];
  return typeof value === "string" && value.trim().toLowerCase() === "already adopted";
}

function parseErrorBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeSquarePage(raw: unknown): ApiPage<SquareAgent> {
  const record = asRecord(raw, "Square feed");
  const items = asArray(record.items, "Square feed items").map((item) => {
    const entry = asRecord(item, "Square feed item");
    const profile = asRecord(entry.agent_profile, "Square agent profile");
    const id = Number(profile.agent_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid Square agent id");
    return { id, name: String(profile.display_name ?? entry.title ?? `Agent ${id}`) };
  });
  const cursor = typeof record.next_cursor === "string" ? record.next_cursor : null;
  const next = record.has_more === true && cursor ? { cursor } : null;
  return { items, next, fingerprint: fingerprint(items.map((item) => String(item.id))) };
}

function normalizePredictionsPage(raw: unknown, limit: number): ApiPage<AgentPrediction> {
  const record = asRecord(raw, "Predictions");
  const normalized = asArray(record.items, "Prediction items").map((item) => {
    const entry = asRecord(item, "Prediction item");
    const cursorId = Number(entry.id);
    const predictionId = String(entry.prediction_id ?? "");
    const opinionId = Number(entry.opinion_id);
    const createdAt = String(entry.created_at ?? entry.opinion_created_at ?? "");
    if (
      !Number.isInteger(cursorId)
      || cursorId <= 0
      || !predictionId
      || !Number.isInteger(opinionId)
      || opinionId <= 0
      || !createdAt
    ) {
      throw new Error("Invalid prediction identity");
    }
    return {
      cursorId,
      prediction: {
        predictionId,
        opinionId,
        createdAt,
        viewerHasIntaken: entry.viewer_has_intaken === true,
      },
    };
  });
  const items = normalized.map((item) => item.prediction);
  const lastCursor = normalized.at(-1)?.cursorId;
  const next = items.length >= limit && lastCursor !== undefined
    ? { before: lastCursor }
    : null;
  return {
    items,
    next,
    fingerprint: fingerprint(items.map((item) => item.predictionId)),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function fingerprint(ids: string[]): string {
  if (ids.length === 0) return "empty";
  return `${ids[0]}:${ids.at(-1)}:${ids.length}`;
}
