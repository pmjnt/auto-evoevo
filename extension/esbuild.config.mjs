import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const shared = { bundle: true, format: "iife", target: "chrome120", minify: false };

await Promise.all([
  build({ ...shared, entryPoints: ["src/background/index.ts"], outfile: "dist/background.js" }),
  build({ ...shared, entryPoints: ["src/content/index.ts"], outfile: "dist/content.js" }),
  build({ ...shared, entryPoints: ["src/inpage/entry.ts"], outfile: "dist/inpage.js" }),
  build({ ...shared, entryPoints: ["src/ui/popup.ts"], outfile: "dist/popup.js" }),
  build({ ...shared, entryPoints: ["src/ui/options.ts"], outfile: "dist/options.js" }),
]);

copyFileSync("src/ui/popup.html", "dist/popup.html");
copyFileSync("src/ui/options.html", "dist/options.html");
copyFileSync("manifest.json", "dist/manifest.json");

console.log("Built dist/");
