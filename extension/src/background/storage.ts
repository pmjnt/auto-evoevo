import { z } from "zod";
import type { ExtensionConfig } from "../shared/types.js";
import type { Vault } from "../shared/crypto.js";

const HEX = /^0x[0-9a-fA-F]*$/;

const vaultSchema = z.object({
  version: z.literal(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

const configSchema = z.object({
  allowedOrigin: z.string().url(),
  allowedChain: z.string().min(1),
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  allowedContracts: z.array(z.string().regex(HEX)),
  allowedFunctionSelectors: z.array(z.string().regex(HEX)),
  maxFeeNative: z.number().positive(),
  dryRun: z.boolean(),
  idleLockMinutes: z.number().int().positive(),
  cooldownSeconds: z.number().int().min(0).max(300).default(0),
  stopAtRemaining: z.number().int().min(0).max(1000).default(10),
  runMode: z.enum(["dom", "direct"]).default("dom"),
  agentId: z.number().int().min(0).default(0),
});

export async function getVault(): Promise<Vault | null> {
  const stored = await chrome.storage.local.get("vault");
  const raw = (stored as Record<string, unknown>)["vault"];
  if (raw == null) return null;
  return vaultSchema.parse(raw) as Vault;
}

export async function setVault(vault: Vault): Promise<void> {
  await chrome.storage.local.set({ vault });
}

export async function getConfig(): Promise<ExtensionConfig | null> {
  const stored = await chrome.storage.local.get("config");
  const raw = (stored as Record<string, unknown>)["config"];
  if (raw == null) return null;
  return configSchema.parse(raw);
}

export async function setConfig(config: ExtensionConfig): Promise<void> {
  await chrome.storage.local.set({ config });
}
