import { describe, it, expect, vi } from "vitest";
import { EvoEvoApiClient, EvoEvoAuthError } from "../src/background/evoevo-api.js";

const ADDR = "0x373226eb7ec2458a41520d3a375dbf82cc1e1c4c";
const TOKEN = "header.payload.signature";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetchAuth(): typeof fetch {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/v1/auth/nonce")) {
      return jsonResponse({ message: "msg", nonce: "n1" });
    }
    if (url.endsWith("/v1/auth/login")) {
      return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z", address: ADDR });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

describe("EvoEvoApiClient", () => {
  it("ensureAuth runs SIWE once and caches the token", async () => {
    const fetchFn = fakeFetchAuth();
    const client = new EvoEvoApiClient({ fetchFn });
    expect(client.isAuthed()).toBe(false);

    await client.ensureAuth(ADDR, async () => "0xsig");
    expect(client.isAuthed()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await client.ensureAuth(ADDR, async () => "0xsig");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("re-auths if the cached token is near expiry", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
      if (url.endsWith("/v1/auth/login"))
        return jsonResponse({ token: TOKEN, expires_at: new Date(Date.now() - 1000).toISOString() });
      throw new Error("nope");
    }) as unknown as typeof fetch;
    const client = new EvoEvoApiClient({ fetchFn });
    await client.ensureAuth(ADDR, async () => "0xsig");
    expect(client.isAuthed()).toBe(false);
    await client.ensureAuth(ADDR, async () => "0xsig");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("listAgents sends Authorization Bearer header", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
      if (url.endsWith("/v1/auth/login"))
        return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
      captured = { url, headers: (init?.headers ?? {}) as Record<string, string> };
      return jsonResponse([{ id: 8359, name: "Test", onchain_identity: null, active: true }]);
    }) as unknown as typeof fetch;

    const client = new EvoEvoApiClient({ fetchFn });
    await client.ensureAuth(ADDR, async () => "0xsig");
    const agents = await client.listAgents(ADDR, 16661);

    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe(8359);
    expect(captured!.url).toBe(
      `https://api.evoevo.ai/v1/agents?wallet_address=${ADDR}&chain_id=16661`,
    );
    expect(captured!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("listFeed encodes query params for the given tab", async () => {
    let url = "";
    const fetchFn = vi.fn(async (called: string) => {
      if (called.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
      if (called.endsWith("/v1/auth/login"))
        return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
      url = called;
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const client = new EvoEvoApiClient({ fetchFn });
    await client.ensureAuth(ADDR, async () => "0xsig");
    await client.listFeed({ tab: "weekly", chainId: 16661, agentId: 8359 });
    expect(url).toBe(
      "https://api.evoevo.ai/v1/platform/feeding?tab=weekly&limit=20&chain_id=16661&agent_id=8359&include_intaken=false",
    );
  });

  it("memoryFromOpinion posts the opinion id and returns the signed payload", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchFn = vi.fn(async (called: string, init?: RequestInit) => {
      if (called.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
      if (called.endsWith("/v1/auth/login"))
        return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
      captured = { url: called, body: String(init?.body ?? "") };
      return jsonResponse({
        chain_action: "reasoning_intake_commit",
        memory_id: 99,
        opinion_id: 2956,
        status: "pending_chain",
        target_agent_id: 8359,
        token_id: "4644",
        reasoning_intake_with_sig: {
          chain_id: 16661,
          contract_address: "0x61bb71442749d13a4BB7257DfBFFf0452ae937f9",
          method: "intakeReasoningV2",
          identity_registry_address: "0x8004Ae533a0301CbD7508373b663756D26DfB028",
          updater: ADDR,
          token_id: "4644",
          source_opinion_id: "2956",
          reasoning_hash: "0x0f64",
          opinion_hash: "0x90c9",
          new_memory_root: "0x4100",
          nonce: "158",
          deadline: "1779765840",
          expires_at: "2026-05-26T03:24:00Z",
          signature: "0xa0c3",
        },
      });
    }) as unknown as typeof fetch;
    const client = new EvoEvoApiClient({ fetchFn });
    await client.ensureAuth(ADDR, async () => "0xsig");
    const result = await client.memoryFromOpinion(8359, 2956);
    expect(captured!.url).toBe(
      "https://api.evoevo.ai/v1/agents/8359/memories/from-opinion",
    );
    expect(JSON.parse(captured!.body)).toEqual({ opinion_id: 2956 });
    expect(result.reasoning_intake_with_sig.source_opinion_id).toBe("2956");
    expect(result.reasoning_intake_with_sig.method).toBe("intakeReasoningV2");
    expect(result.reasoning_intake_with_sig.identity_registry_address).toBe(
      "0x8004Ae533a0301CbD7508373b663756D26DfB028",
    );
  });

  it("throws EvoEvoAuthError on 401 and clears cached auth", async () => {
    const fetchFn = vi.fn(async (called: string) => {
      if (called.endsWith("/v1/auth/nonce")) return jsonResponse({ message: "m", nonce: "n" });
      if (called.endsWith("/v1/auth/login"))
        return jsonResponse({ token: TOKEN, expires_at: "3026-01-01T00:00:00Z" });
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;
    const client = new EvoEvoApiClient({ fetchFn });
    await client.ensureAuth(ADDR, async () => "0xsig");
    await expect(client.listAgents(ADDR, 16661)).rejects.toBeInstanceOf(
      EvoEvoAuthError,
    );
    expect(client.isAuthed()).toBe(false);
  });
});
