import { readFileSync } from "node:fs";
const har = JSON.parse(readFileSync(process.argv[2], "utf8"));
const entries = har.log.entries.filter((e) => e.request.url.includes("api.evoevo.ai"));
const headerCounts = new Map();
for (const e of entries) {
  for (const h of e.request.headers) {
    headerCounts.set(h.name.toLowerCase(), (headerCounts.get(h.name.toLowerCase()) ?? 0) + 1);
  }
}
const sorted = Array.from(headerCounts.entries()).sort((a, b) => b[1] - a[1]);
for (const [name, count] of sorted) {
  console.log(`  ${String(count).padStart(3)}  ${name}`);
}
