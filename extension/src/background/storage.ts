import { z } from "zod";
import type { ExtensionConfig } from "../shared/types.js";

const HEX = /^0x[0-9a-fA-F]*$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const CURRENT_INTAKE_SELECTOR = "0xa29adb25";
const LEGACY_INTAKE_SELECTORS = new Set(["0x4ed1f275", "0xd0e30db0"]);

const configSchema = z.object({
  allowedOrigin: z.string().url(),
  allowedChain: z.string().min(1),
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  allowedContracts: z.array(z.string().regex(HEX)),
  allowedFunctionSelectors: z.array(z.string().regex(HEX)),
  maxFeeNative: z.number().positive(),
  gasPriceJitterPercent: z.number().min(0).max(100).default(10),
  dryRun: z.boolean(),
  cooldownSeconds: z.number().int().min(0).max(300).default(0),
  stopAtRemaining: z.number().int().min(0).max(1000).default(10),
  agentId: z.number().int().min(0).default(0),
});

// Private key stored as plaintext in chrome.storage.local. No vault, no
// password. Anyone with access to the Chrome profile can read it; the
// design assumes one burner wallet per recipient and OOB key handoff.
export async function getPrivateKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get("privateKey");
  const raw = (stored as Record<string, unknown>)["privateKey"];
  if (typeof raw !== "string") return null;
  if (!PRIVATE_KEY_PATTERN.test(raw)) return null;
  return raw;
}

export async function setPrivateKey(privateKey: string): Promise<void> {
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error("Invalid private key — expected 0x + 64 hex");
  }
  await chrome.storage.local.set({ privateKey });
}

export async function clearPrivateKey(): Promise<void> {
  await chrome.storage.local.remove("privateKey");
}

export async function getConfig(): Promise<ExtensionConfig | null> {
  const stored = await chrome.storage.local.get("config");
  const raw = (stored as Record<string, unknown>)["config"];
  if (raw == null) return null;
  return normalizeConfig(configSchema.parse(raw));
}

export async function setConfig(config: ExtensionConfig): Promise<void> {
  await chrome.storage.local.set({ config: normalizeConfig(config) });
}

function normalizeConfig(config: ExtensionConfig): ExtensionConfig {
  const selectors = config.allowedFunctionSelectors
    .map((selector) => selector.toLowerCase())
    .filter((selector) => !LEGACY_INTAKE_SELECTORS.has(selector));

  if (!selectors.includes(CURRENT_INTAKE_SELECTOR)) {
    selectors.push(CURRENT_INTAKE_SELECTOR);
  }

  return {
    ...config,
    allowedContracts: config.allowedContracts.map((contract) =>
      contract.toLowerCase(),
    ),
    allowedFunctionSelectors: selectors,
  };
}
