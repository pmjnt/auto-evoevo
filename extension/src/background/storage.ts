import { z } from "zod";
import type {
  ExtensionConfig,
  WorkflowState,
} from "../shared/types.js";

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
  memoryApiCooldownSeconds: z.number().int().min(0).max(60).default(1),
  predictionReadCooldownSeconds: z.number().int().min(0).max(60).default(2),
  rateLimitBackoffMinutes: z.number().int().min(1).max(1440).default(15),
  stopAtRemaining: z.number().int().min(0).max(1000).default(10),
  agentId: z.number().int().min(0).default(0),
  repeatIntervalMinutes: z.number().int().min(30).max(1440).default(120),
  reconciliationIntervalMinutes: z.number().int().min(30).max(1440).default(1440),
});

const retryItemSchema = z.object({
  predictionId: z.string().min(1),
  opinionId: z.number().int().positive(),
  sourceAgentId: z.number().int().positive(),
  targetAgentId: z.number().int().positive(),
  attempts: z.number().int().min(0),
  retryAfter: z.number().nonnegative(),
});

const countersSchema = z.object({
  ownedAgents: z.number().int().nonnegative(),
  feedAgentsCompleted: z.number().int().nonnegative(),
  sourceAgents: z.number().int().nonnegative(),
  predictionsScanned: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  registryBytes: z.number().int().nonnegative(),
});

const workflowStateSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["feed", "predictions", "both"]).nullable(),
  status: z.enum(["idle", "running", "paused", "error"]),
  activeWorkflow: z.enum(["feed", "predictions"]).nullable(),
  nextRunAt: z.number().nonnegative().nullable(),
  lastIncrementalAt: z.number().nonnegative().nullable(),
  lastReconciliationAt: z.number().nonnegative().nullable(),
  feedAgentIndex: z.number().int().nonnegative(),
  feedTab: z.enum(["recommended", "weekly", "monthly", "all_time"]).nullable(),
  squareOffset: z.number().int().nonnegative(),
  sourceAgentIds: z.array(z.number().int().positive()),
  completedPredictionSourceIds: z.array(z.number().int().positive()).default([]),
  predictionScanStartedAt: z.number().nonnegative().nullable().default(null),
  predictionOffsets: z.record(z.number().int().nonnegative()),
  retryQueue: z.array(retryItemSchema),
  blockedPredictionIds: z.array(z.string().min(1)),
  counters: countersSchema,
  lastError: z.string().nullable(),
});

export const DEFAULT_WORKFLOW_STATE: WorkflowState = {
  version: 1,
  mode: null,
  status: "idle",
  activeWorkflow: null,
  nextRunAt: null,
  lastIncrementalAt: null,
  lastReconciliationAt: null,
  feedAgentIndex: 0,
  feedTab: null,
  squareOffset: 0,
  sourceAgentIds: [],
  completedPredictionSourceIds: [],
  predictionScanStartedAt: null,
  predictionOffsets: {},
  retryQueue: [],
  blockedPredictionIds: [],
  counters: {
    ownedAgents: 0,
    feedAgentsCompleted: 0,
    sourceAgents: 0,
    predictionsScanned: 0,
    added: 0,
    skipped: 0,
    failed: 0,
    registryBytes: 0,
  },
  lastError: null,
};

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

export async function getWorkflowState(): Promise<WorkflowState> {
  const stored = await chrome.storage.local.get("workflowState");
  const raw = (stored as Record<string, unknown>)["workflowState"];
  if (raw == null) return structuredClone(DEFAULT_WORKFLOW_STATE);
  return workflowStateSchema.parse(raw);
}

export async function setWorkflowState(state: WorkflowState): Promise<void> {
  await chrome.storage.local.set({ workflowState: workflowStateSchema.parse(state) });
}

export async function getPredictionIds(): Promise<string[]> {
  const stored = await chrome.storage.local.get("predictionIds");
  const raw = (stored as Record<string, unknown>)["predictionIds"];
  if (raw == null) return [];
  return z.array(z.string().min(1)).parse(raw);
}

export async function setPredictionIds(ids: string[]): Promise<void> {
  const normalized = [...new Set(ids)].sort();
  await chrome.storage.local.set({ predictionIds: normalized });
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
