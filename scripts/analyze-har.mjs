// Extract a summary of an HAR capture: distinct origins, endpoints, RPC
// method calls, and any obvious authentication exchanges. Designed to
// run once against a manual capture from evoevo.ai while reverse
// engineering its public surface.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node analyze-har.mjs <path-to.har>");
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, "utf8"));
const entries = har.log?.entries ?? [];

const byOrigin = new Map();
const rpcMethods = new Map();
const authLike = [];
const interestingPosts = [];

for (const entry of entries) {
  const { request, response } = entry;
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname + url.search;

  if (!byOrigin.has(origin)) byOrigin.set(origin, new Map());
  const methodsByPath = byOrigin.get(origin);
  const key = `${request.method} ${path}`;
  methodsByPath.set(key, (methodsByPath.get(key) ?? 0) + 1);

  // JSON-RPC call detection
  if (
    request.method === "POST" &&
    request.postData?.mimeType?.includes("json")
  ) {
    try {
      const body = JSON.parse(request.postData.text ?? "{}");
      if (Array.isArray(body)) {
        for (const b of body) {
          if (b.method) {
            rpcMethods.set(b.method, (rpcMethods.get(b.method) ?? 0) + 1);
          }
        }
      } else if (body.method) {
        rpcMethods.set(body.method, (rpcMethods.get(body.method) ?? 0) + 1);
      }
    } catch {
      // not JSON; ignore
    }
  }

  // Auth keywords
  if (
    /siwe|login|auth|nonce|session|verify|connect|signature/i.test(path) ||
    /siwe|signature|message/i.test(request.postData?.text ?? "")
  ) {
    authLike.push({
      method: request.method,
      url: origin + path,
      status: response.status,
      requestSnippet: (request.postData?.text ?? "").slice(0, 400),
      responseSnippet: (response.content?.text ?? "").slice(0, 400),
    });
  }

  // Interesting POST/PUT with JSON body to non-RPC endpoints
  if (
    ["POST", "PUT"].includes(request.method) &&
    !rpcMethods.size &&
    !/rpc|jsonrpc/i.test(path)
  ) {
    interestingPosts.push({
      method: request.method,
      url: origin + path,
      status: response.status,
      requestSnippet: (request.postData?.text ?? "").slice(0, 200),
    });
  }
}

console.log("=".repeat(70));
console.log("ORIGINS & ENDPOINTS");
console.log("=".repeat(70));
for (const [origin, paths] of byOrigin) {
  const sorted = Array.from(paths.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`\n${origin}  (${sorted.length} unique endpoints)`);
  for (const [key, count] of sorted.slice(0, 40)) {
    console.log(`  ${String(count).padStart(3)}x  ${key}`);
  }
  if (sorted.length > 40) {
    console.log(`  ... +${sorted.length - 40} more`);
  }
}

console.log("\n" + "=".repeat(70));
console.log("JSON-RPC METHODS");
console.log("=".repeat(70));
const rpcSorted = Array.from(rpcMethods.entries()).sort((a, b) => b[1] - a[1]);
for (const [method, count] of rpcSorted) {
  console.log(`  ${String(count).padStart(3)}x  ${method}`);
}

console.log("\n" + "=".repeat(70));
console.log(`AUTH-LIKE EXCHANGES (${authLike.length})`);
console.log("=".repeat(70));
for (const a of authLike.slice(0, 20)) {
  console.log(`\n${a.method} ${a.url}  -> ${a.status}`);
  if (a.requestSnippet) console.log(`  REQ: ${a.requestSnippet}`);
  if (a.responseSnippet) console.log(`  RES: ${a.responseSnippet}`);
}
if (authLike.length > 20) {
  console.log(`\n... +${authLike.length - 20} more`);
}
