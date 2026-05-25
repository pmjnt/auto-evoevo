import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";

// Avoid rmSync when Chrome has the unpacked extension loaded — it keeps
// files open and the recursive delete fails. Overwrite-in-place is safe
// because every bundled file is regenerated below.
try {
  rmSync("dist", { recursive: true, force: true });
} catch (error) {
  if (!(error && typeof error === "object" && /EBUSY|EPERM/.test(String(error.code)))) {
    throw error;
  }
}
mkdirSync("dist", { recursive: true });

const shared = { bundle: true, format: "iife", target: "chrome120", minify: false };

await Promise.all([
  build({ ...shared, entryPoints: ["src/background/index.ts"], outfile: "dist/background.js" }),
  build({ ...shared, entryPoints: ["src/ui/popup.ts"], outfile: "dist/popup.js" }),
  build({ ...shared, entryPoints: ["src/ui/options.ts"], outfile: "dist/options.js" }),
]);

copyFileSync("src/ui/popup.html", "dist/popup.html");
copyFileSync("src/ui/options.html", "dist/options.html");
copyFileSync("manifest.json", "dist/manifest.json");
cpSync("src/assets/icons", "dist/icons", { recursive: true });

console.log("Built dist/");
