import { readFileSync } from "node:fs";
const har = JSON.parse(readFileSync(process.argv[2], "utf8"));
const matched = har.log.entries.filter((e) => e.request.url.includes(process.argv[3]));
for (const e of matched) {
  console.log(`${e.request.method} ${e.request.url}`);
  console.log("Response headers:");
  for (const h of e.response.headers) {
    const v = h.value.length > 200 ? h.value.slice(0, 150) + "...(" + h.value.length + ")" : h.value;
    console.log(`  ${h.name}: ${v}`);
  }
  console.log();
}
