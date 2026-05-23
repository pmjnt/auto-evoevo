import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

// Avoid failing when Chrome has the unpacked extension loaded and keeps files
// open. Overwrite-in-place is safe because every bundled file is regenerated.
try {
  rmSync(dist, { recursive: true, force: true });
} catch (error) {
  if (!(error && typeof error === "object" && /EBUSY|EPERM/.test(String(error.code)))) {
    throw error;
  }
}
mkdirSync(dist, { recursive: true });

const shared = { bundle: true, format: "iife", target: "chrome120", minify: false };

await Promise.all([
  build({ ...shared, entryPoints: [join(root, "src/background/index.ts")], outfile: join(dist, "background.js") }),
  build({ ...shared, entryPoints: [join(root, "src/content/index.ts")], outfile: join(dist, "content.js") }),
  build({ ...shared, entryPoints: [join(root, "src/inpage/entry.ts")], outfile: join(dist, "inpage.js") }),
  build({ ...shared, entryPoints: [join(root, "src/ui/popup.ts")], outfile: join(dist, "popup.js") }),
  build({ ...shared, entryPoints: [join(root, "src/ui/options.ts")], outfile: join(dist, "options.js") }),
]);

copyFileSync(join(root, "src/ui/popup.html"), join(dist, "popup.html"));
copyFileSync(join(root, "src/ui/options.html"), join(dist, "options.html"));
copyFileSync(join(root, "manifest.json"), join(dist, "manifest.json"));
cpSync(join(root, "src/assets/icons"), join(dist, "icons"), { recursive: true });

console.log("Built dist/");
