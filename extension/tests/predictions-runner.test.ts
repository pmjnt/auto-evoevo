import { describe, expect, it, vi } from "vitest";
import { runPredictions } from "../src/background/predictions-runner.js";
import { DEFAULT_WORKFLOW_STATE } from "../src/background/storage.js";
import type {
  AgentPrediction,
  ApiPage,
  PageRequest,
  SquareAgent,
} from "../src/background/evoevo-api.js";
import type { PredictionRegistry } from "../src/background/prediction-registry.js";
import type { WorkflowState } from "../src/shared/types.js";

const prediction = (predictionId: string, opinionId = Number(predictionId.replace(/\D/g, "")) || 1): AgentPrediction => ({
  predictionId,
  opinionId,
  createdAt: "2026-06-20T00:00:00Z",
});

const page = <T>(items: T[], next: PageRequest | null): ApiPage<T> => ({
  items,
  next,
  fingerprint: items.map((item) => JSON.stringify(item)).join("|") || "empty",
});

function registry(seed: string[] = []): PredictionRegistry {
  const known = new Set(seed);
  const blocked = new Set<string>();
  return {
    has: async (id) => known.has(id) || blocked.has(id),
    claim: async (id) => !known.has(id) && !blocked.has(id),
    complete: async (id) => { known.add(id); },
    completePage: async (ids) => { ids.forEach((id) => known.add(id)); },
    block: async (id) => { blocked.add(id); },
    isBlocked: async (id) => blocked.has(id),
    retry: async () => undefined,
    dueRetries: async () => [],
    removeRetry: async () => undefined,
    storageBytes: async () => known.size + blocked.size,
  };
}

function harness(options: { known?: string[]; state?: Partial<WorkflowState> } = {}) {
  let state: WorkflowState = {
    ...structuredClone(DEFAULT_WORKFLOW_STATE),
    ...options.state,
  };
  const submitted: string[] = [];
  const squarePages = new Map<string, ApiPage<SquareAgent>>([
    ["first", page([{ id: 3314, name: "Source" }], null)],
  ]);
  const predictionPages = new Map<number, ApiPage<AgentPrediction>[]>([
    [3314, [page([prediction("new-first"), prediction("known-middle")], { offset: 2 }), page([prediction("new-after-known")], null)]],
  ]);
  const requestedSources: number[] = [];
  return {
    submitted,
    requestedSources,
    deps: {
      api: {
        listAgents: vi.fn(async () => [{ id: 900, name: "Target", active: true, onchain_identity: null }]),
        listSquareAgents: vi.fn(async ({ cursor }: { cursor?: string }) => squarePages.get(cursor ?? "first")!),
        listAgentPredictions: vi.fn(async ({ sourceAgentId, offset = 0 }: { sourceAgentId: number; offset?: number }) => {
          requestedSources.push(sourceAgentId);
          return predictionPages.get(sourceAgentId)![offset === 0 ? 0 : 1]!;
        }),
      },
      walletAddress: "0x" + "11".repeat(20),
      chainId: 16661,
      registry: registry(options.known),
      checkpoint: {
        load: async () => state,
        save: async (next: WorkflowState) => { state = structuredClone(next); },
      },
      submitPrediction: async (_targetAgentId: number, item: AgentPrediction) => {
        submitted.push(item.predictionId);
        return { kind: "approved" as const, txHash: `0x${item.opinionId}` };
      },
      isPaused: () => false,
      onProgress: () => undefined,
    },
    get state() { return state; },
    predictionPages,
  };
}

describe("Predictions runner", () => {
  it("full scan finds an unknown ID after a known ID", async () => {
    const setup = harness({ known: ["known-middle"] });

    await runPredictions(setup.deps, { scan: "full", targetAgentId: 900 });

    expect(setup.submitted).toEqual(["new-first", "new-after-known"]);
    expect(setup.state.sourceAgentIds).toEqual([3314]);
  });

  it("incremental reads newest page for persisted sources", async () => {
    const setup = harness({ state: { sourceAgentIds: [3314] } });

    await runPredictions(setup.deps, { scan: "incremental", targetAgentId: 900 });

    expect(setup.requestedSources[0]).toBe(3314);
  });

  it("rejects a target that is not owned by the wallet", async () => {
    const setup = harness();

    await expect(runPredictions(setup.deps, { scan: "full", targetAgentId: 999 })).resolves.toEqual({
      kind: "failed",
      reason: "Prediction target is not owned by this wallet",
      global: true,
    });
  });
});
