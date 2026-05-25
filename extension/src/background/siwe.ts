// SIWE login flow against EvoEvo's REST API.
// POST /v1/auth/nonce -> sign returned message -> POST /v1/auth/login -> JWT.

export type SiweAuth = {
  token: string;
  expiresAt: string; // ISO timestamp from the API
  address: string;
};

export type SiweOptions = {
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

const DEFAULT_BASE = "https://api.evoevo.ai";

export async function siweLogin(
  address: string,
  signMessage: (message: string) => Promise<string>,
  options: SiweOptions = {},
): Promise<SiweAuth> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  const lowerAddress = address.toLowerCase();

  const nonceResponse = await fetchFn(`${baseUrl}/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evoevo.ai" },
    body: JSON.stringify({ address: lowerAddress }),
  });
  if (!nonceResponse.ok) {
    throw new Error(`SIWE nonce failed: HTTP ${nonceResponse.status}`);
  }
  const nonceBody = (await nonceResponse.json()) as {
    message?: string;
    nonce?: string;
  };
  if (!nonceBody.message || !nonceBody.nonce) {
    throw new Error("SIWE nonce response missing message or nonce");
  }

  const signature = await signMessage(nonceBody.message);

  const loginResponse = await fetchFn(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evoevo.ai" },
    body: JSON.stringify({
      address: lowerAddress,
      nonce: nonceBody.nonce,
      signature,
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`SIWE login failed: HTTP ${loginResponse.status}`);
  }
  const loginBody = (await loginResponse.json()) as {
    token?: string;
    expires_at?: string;
    address?: string;
  };
  if (!loginBody.token || !loginBody.expires_at) {
    throw new Error("SIWE login response missing token or expires_at");
  }

  return {
    token: loginBody.token,
    expiresAt: loginBody.expires_at,
    address: loginBody.address ?? lowerAddress,
  };
}
