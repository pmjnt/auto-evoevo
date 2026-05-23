import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("manifest.json", () => {
  it("has the expected MV3 shape", () => {
    const raw = readFileSync(resolve(__dirname, "..", "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeDefined();
    expect(manifest.content_scripts[0].matches).toEqual(["https://evoevo.ai/*"]);
    expect(manifest.content_scripts[0].run_at).toBe("document_start");
    // inpage runs in MAIN world so the page sees the provider directly.
    const inpageEntry = manifest.content_scripts.find((entry: { js: string[]; world?: string }) =>
      entry.js.includes("inpage.js"),
    );
    expect(inpageEntry).toBeDefined();
    expect(inpageEntry.world).toBe("MAIN");
    expect(inpageEntry.run_at).toBe("document_start");
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.options_page).toBe("options.html");
    expect(manifest.web_accessible_resources[0].resources).toContain("inpage.js");
    expect(manifest.permissions).toEqual(expect.arrayContaining(["storage", "scripting"]));
  });
});
