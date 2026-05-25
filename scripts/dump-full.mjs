// Print all headers + body for matched entries.
import { readFileSync } from "node:fs";

const path = process.argv[2];
const pattern = process.argv[3];
if (!path || !pattern) {
  console.error("usage: node dump-full.mjs <path-to.har> <url-substring>");
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, "utf8"));
const entries = har.log?.entries ?? [];

const matched = entries.filter((e) => e.request.url.includes(pattern)).slice(0, 1);
for (const e of matched) {
  console.log("=".repeat(80));
  console.log(`${e.request.method} ${e.request.url}`);
  console.log(`-> ${e.response.status}`);
  console.log("\nRequest headers:");
  for (const h of e.request.headers) {
    const v = h.value.length > 120 ? h.value.slice(0, 80) + "...(truncated " + h.value.length + " chars)" : h.value;
    console.log(`  ${h.name}: ${v}`);
  }
  console.log("\nRequest body:");
  console.log("  " + (e.request.postData?.text ?? "(none)").slice(0, 500));
}
