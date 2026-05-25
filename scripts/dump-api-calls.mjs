// Print full request + response bodies for a specific origin/path
// pattern from an HAR capture.

import { readFileSync } from "node:fs";

const path = process.argv[2];
const pattern = process.argv[3];
if (!path || !pattern) {
  console.error("usage: node dump-api-calls.mjs <path-to.har> <url-substring>");
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, "utf8"));
const entries = har.log?.entries ?? [];

const matched = entries.filter((e) => e.request.url.includes(pattern));
console.log(`Matched ${matched.length} entries\n`);

for (const e of matched) {
  console.log("=".repeat(80));
  console.log(`${e.request.method} ${e.request.url}`);
  console.log(`-> ${e.response.status} ${e.response.statusText}`);

  const reqHeaders = e.request.headers
    .filter((h) =>
      /authorization|content-type|cookie/i.test(h.name) &&
      !/^cookie$/i.test(h.name),
    )
    .map((h) => `  ${h.name}: ${h.value.length > 200 ? h.value.slice(0, 80) + "...(truncated)" : h.value}`)
    .join("\n");
  console.log("Request headers:");
  console.log(reqHeaders || "  (none of interest)");

  if (e.request.postData?.text) {
    console.log("Request body:");
    console.log("  " + e.request.postData.text.slice(0, 3000));
  }
  if (e.response.content?.text) {
    console.log("Response body:");
    console.log("  " + e.response.content.text.slice(0, 3000));
  }
  console.log();
}
