import { readFileSync } from "node:fs";
const har = JSON.parse(readFileSync(process.argv[2], "utf8"));
const matched = har.log.entries.filter((e) => e.request.url.includes(process.argv[3]));
for (const e of matched.slice(0, 1)) {
  console.log(`${e.request.method} ${e.request.url}`);
  console.log("\nCookies on request:");
  for (const c of e.request.cookies ?? []) {
    console.log(`  ${c.name}=${c.value.length > 80 ? c.value.slice(0, 60) + "...(" + c.value.length + ")" : c.value}`);
  }
  if ((e.request.cookies ?? []).length === 0) console.log("  (none)");
}
