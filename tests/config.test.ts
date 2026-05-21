import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";

const RABBY_EXTENSION_ID = "acmacodkjbdgmoleebolmdjonilkdbch";

function writeConfig(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-evoevo-config-"));
  const configPath = join(dir, "config.json");
  const config = {
    evoevoUrl: "https://evoevo.ai/feed",
    chromeProfilePath: "chrome-profile",
    rabbyExtensionId: RABBY_EXTENSION_ID,
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    allowedContracts: ["0x61BB710000000000000000000000000000E937F9"],
    maxFeeNative: 0.001,
    allowLearnedActionPattern: false,
    dryRun: true,
    timeoutsMs: {
      pageLoad: 30000,
      popup: 20000,
      signing: 30000,
      feedExpansion: 15000,
    },
    logDir: "logs",
    ...overrides,
  };

  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function withConfigPath<T>(
  overrides: Record<string, unknown>,
  callback: (configPath: string) => T,
): T {
  const configPath = writeConfig(overrides);
  const dir = dirname(configPath);

  try {
    return callback(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  test("loads valid config and normalizes allowed contracts", () => {
    withConfigPath({}, (configPath) => {
      expect(loadConfig(configPath).allowedContracts).toEqual([
        "0x61bb710000000000000000000000000000e937f9",
      ]);
    });
  });

  test("rejects uppercase Rabby extension ID", () => {
    withConfigPath(
      { rabbyExtensionId: RABBY_EXTENSION_ID.toUpperCase() },
      (configPath) => {
        expect(() => loadConfig(configPath)).toThrow();
      },
    );
  });

  test("rejects invalid non-Chrome-extension ID", () => {
    withConfigPath({ rabbyExtensionId: "not-a-chrome-extension-id" }, (configPath) => {
      expect(() => loadConfig(configPath)).toThrow();
    });
  });
});
