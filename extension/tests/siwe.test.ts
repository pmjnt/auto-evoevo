import { describe, it, expect, vi } from "vitest";
import { siweLogin } from "../src/background/siwe.js";

const ADDR = "0x373226eb7ec2458a41520d3a375dbf82cc1e1c4c";
const NONCE = "85706451218ef7c77ea31cd014aba6ac";
const MESSAGE =
  "EvoEvo wants you to sign in with your Ethereum account:\n" +
  ADDR +
  "\n\nNonce: " +
  NONCE +
  "\nIssued At: 2026-05-25T03:23:40Z\nExpiration Time: 2026-05-25T03:28:40Z";
const SIGNATURE = "0xdeadbeef" + "00".repeat(60);
const TOKEN = "header.payload.signature";

function fakeFetch(handlers: Array<(input: string, init?: RequestInit) => Response>) {
  let i = 0;
  return vi.fn(async (input: string, init?: RequestInit) => {
    if (i >= handlers.length) {
      throw new Error("fetch called more times than handlers");
    }
    return handlers[i++]!(input, init);
  }) as unknown as typeof fetch;
}

describe("siweLogin", () => {
  it("performs nonce -> sign -> login and returns the token", async () => {
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = fakeFetch([
      (url, init) => {
        fetchCalls.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            message: MESSAGE,
            nonce: NONCE,
            address: ADDR,
            expires_at: "2026-05-25T03:28:40Z",
          }),
          { status: 200 },
        );
      },
      (url, init) => {
        fetchCalls.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            address: ADDR,
            token: TOKEN,
            expires_at: "2026-05-26T03:23:42Z",
          }),
          { status: 200 },
        );
      },
    ]);

    const signMessage = vi.fn(async (msg: string) => {
      expect(msg).toBe(MESSAGE);
      return SIGNATURE;
    });

    const auth = await siweLogin(ADDR, signMessage, { fetchFn });

    expect(auth.token).toBe(TOKEN);
    expect(auth.expiresAt).toBe("2026-05-26T03:23:42Z");
    expect(auth.address).toBe(ADDR);

    expect(fetchCalls[0]!.url).toBe("https://api.evoevo.ai/v1/auth/nonce");
    expect(fetchCalls[0]!.body).toEqual({ address: ADDR });
    expect(fetchCalls[1]!.url).toBe("https://api.evoevo.ai/v1/auth/login");
    expect(fetchCalls[1]!.body).toEqual({
      address: ADDR,
      nonce: NONCE,
      signature: SIGNATURE,
    });
    expect(signMessage).toHaveBeenCalledOnce();
  });

  it("lowercases the address before sending", async () => {
    const fetchCalls: Array<{ body: { address: string } }> = [];
    const fetchFn = fakeFetch([
      (_url, init) => {
        fetchCalls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ message: MESSAGE, nonce: NONCE }),
          { status: 200 },
        );
      },
      (_url, init) => {
        fetchCalls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ token: TOKEN, expires_at: "2026-05-26T03:23:42Z" }),
          { status: 200 },
        );
      },
    ]);

    await siweLogin("0xABCDEF0000000000000000000000000000000000", async () => SIGNATURE, {
      fetchFn,
    });

    expect(fetchCalls[0]!.body.address).toBe("0xabcdef0000000000000000000000000000000000");
    expect(fetchCalls[1]!.body.address).toBe("0xabcdef0000000000000000000000000000000000");
  });

  it("throws on nonce failure", async () => {
    const fetchFn = fakeFetch([
      () => new Response("server error", { status: 500 }),
    ]);
    await expect(
      siweLogin(ADDR, async () => SIGNATURE, { fetchFn }),
    ).rejects.toThrow(/nonce/);
  });

  it("throws on login failure", async () => {
    const fetchFn = fakeFetch([
      () =>
        new Response(JSON.stringify({ message: MESSAGE, nonce: NONCE }), {
          status: 200,
        }),
      () => new Response("bad sig", { status: 401 }),
    ]);
    await expect(
      siweLogin(ADDR, async () => SIGNATURE, { fetchFn }),
    ).rejects.toThrow(/login/);
  });
});
