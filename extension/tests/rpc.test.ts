import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcClient } from "../src/background/rpc.js";

function fetchReturning(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let index = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)] ?? responses[responses.length - 1]!;
    index += 1;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
}

describe("rpc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a raw transaction and returns the txHash", async () => {
    const fetchFn = fetchReturning([
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0xabc" } },
    ]);
    const client = new RpcClient("https://rpc.example", fetchFn);
    expect(await client.sendRawTransaction("0xdeadbeef")).toBe("0xabc");
  });

  it("retries 5xx with backoff and eventually succeeds", async () => {
    const fetchFn = fetchReturning([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0xabc" } },
    ]);
    const client = new RpcClient("https://rpc.example", fetchFn);
    const promise = client.sendRawTransaction("0xdeadbeef");
    await vi.runAllTimersAsync();
    expect(await promise).toBe("0xabc");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed retries", async () => {
    const fetchFn = fetchReturning([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    const client = new RpcClient("https://rpc.example", fetchFn);
    const promise = client.sendRawTransaction("0xdeadbeef");
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("getTransactionCount parses hex result", async () => {
    const fetchFn = fetchReturning([
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x10" } },
    ]);
    const client = new RpcClient("https://rpc.example", fetchFn);
    expect(await client.getTransactionCount("0xabc", "pending")).toBe(16);
  });

  it("gasPrice parses to bigint", async () => {
    const fetchFn = fetchReturning([
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x3b9aca00" } },
    ]);
    const client = new RpcClient("https://rpc.example", fetchFn);
    expect(await client.gasPrice()).toBe(1_000_000_000n);
  });

  it("refetches nonce and retries once on nonce-too-low", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const calls: Array<{ method: string; body: any }> = [];
    (fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_input: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({ method: body.method, body });
        if (body.method === "eth_sendRawTransaction" && calls.filter((c) => c.method === "eth_sendRawTransaction").length === 1) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low" } }),
            { status: 200 },
          );
        }
        if (body.method === "eth_getTransactionCount") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x5" }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xnew" }), { status: 200 });
      },
    );

    const client = new RpcClient("https://rpc.example", fetchFn);
    const result = await client.sendRawTransactionWithNonceRetry(
      "0xdeadbeef",
      "0xfrom",
    );
    expect(result.txHash).toBe("0xnew");
    expect(result.refetchedNonce).toBe(5);
  });
});
