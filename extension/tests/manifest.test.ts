import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("manifest.json", () => {
  it("has the expected MV3 shape for the direct-only build", () => {
    const raw = readFileSync(resolve(__dirname, "..", "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.type).toBe("module");
    // Action no longer has a popup — clicking the icon opens the side panel.
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.side_panel.default_path).toBe("popup.html");
    expect(manifest.action.default_icon["128"]).toBe("icons/icon-128.png");
    expect(manifest.icons["128"]).toBe("icons/icon-128.png");
    expect(manifest.options_page).toBe("options.html");
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "storage",
        "sidePanel",
        "declarativeNetRequestWithHostAccess",
      ]),
    );
    // DOM-mode pieces are gone.
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.permissions).not.toContain("scripting");
    expect(manifest.host_permissions).toEqual(["https://api.evoevo.ai/*"]);
    // CORS Origin override rule must be wired in so api.evoevo.ai
    // accepts our requests.
    expect(manifest.declarative_net_request.rule_resources[0].path).toBe(
      "rules.json",
    );
  });
});
