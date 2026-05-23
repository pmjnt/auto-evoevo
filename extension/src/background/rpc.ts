const BACKOFF_MS = [500, 1500, 4500];

type RpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

export class RpcClient {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendRawTransaction(signed: string): Promise<string> {
    const result = await this.call<string>("eth_sendRawTransaction", [signed]);
    return result;
  }

  async sendRawTransactionWithNonceRetry(
    signed: string,
    fromAddress: string,
  ): Promise<{ txHash: string; refetchedNonce: number | null }> {
    try {
      return { txHash: await this.sendRawTransaction(signed), refetchedNonce: null };
    } catch (error) {
      if (!isNonceTooLow(error)) throw error;
      const refetchedNonce = await this.getTransactionCount(fromAddress, "pending");
      throw new NonceRetryNeeded(refetchedNonce);
    }
  }

  async getTransactionCount(address: string, tag: "latest" | "pending"): Promise<number> {
    const hex = await this.call<string>("eth_getTransactionCount", [address, tag]);
    return Number.parseInt(hex, 16);
  }

  async gasPrice(): Promise<bigint> {
    const hex = await this.call<string>("eth_gasPrice", []);
    return BigInt(hex);
  }

  async getTransactionReceipt(hash: string): Promise<unknown | null> {
    return await this.call<unknown | null>("eth_getTransactionReceipt", [hash]);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < BACKOFF_MS.length + 1; attempt += 1) {
      try {
        const response = await this.fetchFn(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!response.ok) {
          throw new Error(`RPC HTTP ${response.status}`);
        }
        const payload = (await response.json()) as RpcResponse<T>;
        if (payload.error) {
          throw new RpcError(payload.error.code, payload.error.message);
        }
        return payload.result as T;
      } catch (error) {
        lastError = error;
        if (error instanceof RpcError) throw error;
        if (attempt < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[attempt] ?? 0);
          continue;
        }
        throw error;
      }
    }
    throw lastError as Error;
  }
}

export class RpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

export class NonceRetryNeeded extends Error {
  constructor(public readonly refetchedNonce: number) {
    super("Nonce retry needed");
  }
}

function isNonceTooLow(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    typeof error.message === "string" &&
    /nonce too low/i.test(error.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
