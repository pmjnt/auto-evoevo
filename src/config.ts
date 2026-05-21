import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { RunnerConfig } from "./types.js";

const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const chromeExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);

const runnerConfigSchema = z.object({
  evoevoUrl: z.string().url(),
  chromeProfilePath: z.string().min(1),
  rabbyExtensionId: chromeExtensionIdSchema,
  allowedOrigin: z.string().url(),
  allowedChain: z.string().min(1),
  allowedContracts: z.array(ethereumAddressSchema).min(1),
  maxFeeNative: z.number().positive(),
  allowLearnedActionPattern: z.boolean(),
  dryRun: z.boolean(),
  timeoutsMs: z.object({
    pageLoad: z.number().int().positive(),
    popup: z.number().int().positive(),
    signing: z.number().int().positive(),
    feedExpansion: z.number().int().positive(),
  }),
  logDir: z.string().min(1),
});

export function loadConfig(configPath = "config.local.json"): RunnerConfig {
  const resolvedPath = resolve(configPath);
  const rawConfig = readFileSync(resolvedPath, "utf8");
  const parsedConfig = runnerConfigSchema.parse(JSON.parse(rawConfig));

  return {
    ...parsedConfig,
    allowedContracts: parsedConfig.allowedContracts.map((contract) =>
      contract.toLowerCase(),
    ),
  };
}
