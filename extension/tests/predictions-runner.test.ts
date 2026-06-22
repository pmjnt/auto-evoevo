import { describe, expect, it, vi } from "vitest";
import {
  runPredictions,
  type PredictionProgressUpdate,
} from "../src/background/predictions-runner.js";
import { DEFAULT_WORKFLOW_STATE } from "../src/background/storage.js";
import type {
  AgentPrediction,
  ApiPage,
  PageRequest,
  SquareAgent,
} from "../src/background/evoevo-api.js";
import { EvoEvoHttpError } from "../src/background/evoevo-api.js";
import type { PredictionRegistry } from "../src/background/prediction-registry.js";
import type { SubmitOutcome } from "../src/background/intake-submitter.js";
import type { WorkflowState } from "../src/shared/types.js";

const prediction = (
  predictionId: string,
  opinionId = Number(predictionId.replace(/\D/g, "")) || 1,
  viewerHasIntaken = false,
): AgentPrediction => ({
  predictionId,
  opinionId,
  createdAt: "2026-06-20T00:00:00Z",
  viewerHasIntaken,
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

function harness(options: {
  known?: string[];
  state?: Partial<WorkflowState>;
  now?: number;
  predictionReadCooldownSeconds?: number;
} = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const now = vi.fn(() => options.now ?? 1_000_000);
  let state: WorkflowState = {
    ...structuredClone(DEFAULT_WORKFLOW_STATE),
    ...options.state,
  };
  const submitted: string[] = [];
  const squarePages = new Map<string, ApiPage<SquareAgent>>([
    ["first", page([{ id: 3314, name: "Source" }], null)],
  ]);
  const predictionPages = new Map<number, ApiPage<AgentPrediction>[]>([
    [3314, [page([prediction("new-first", 101), prediction("known-middle", 202)], { before: 202 }), page([prediction("new-after-known", 303)], null)]],
  ]);
  const requestedSources: number[] = [];
  return {
    submitted,
    requestedSources,
    deps: {
      api: {
        listAgents: vi.fn(async () => [{ id: 900, name: "Target", active: true, onchain_identity: null }]),
        listSquareAgents: vi.fn(async ({ cursor }: { cursor?: string }) => squarePages.get(cursor ?? "first")!),
        listAgentPredictions: vi.fn(async ({ sourceAgentId, before }: { sourceAgentId: number; before?: number }) => {
          requestedSources.push(sourceAgentId);
          return predictionPages.get(sourceAgentId)![before === undefined ? 0 : 1]!;
        }),
      },
      walletAddress: "0x" + "11".repeat(20),
      chainId: 16661,
      config: {
        predictionReadCooldownSeconds: options.predictionReadCooldownSeconds ?? 0,
        rateLimitBackoffMinutes: 15,
      },
      registry: registry(options.known),
      checkpoint: {
        load: async () => state,
        save: async (next: WorkflowState) => { state = structuredClone(next); },
      },
      submitPrediction: async (
        _sourceAgentId: number,
        _targetAgentId: number,
        item: AgentPrediction,
      ): Promise<SubmitOutcome> => {
        submitted.push(item.predictionId);
        return { kind: "approved" as const, txHash: `0x${item.opinionId}` };
      },
      isPaused: () => false,
      onProgress: async (_update: PredictionProgressUpdate): Promise<void> => undefined,
      sleep,
      now,
    },
    get state() { return state; },
    predictionPages,
    sleep,
  };
}

describe("Predictions runner", () => {
  it("full scan finds an unknown ID after a known ID", async () => {
    const setup = harness({ known: ["202"] });

    await runPredictions(setup.deps, { scan: "full", targetAgentId: 900 });

    expect(setup.submitted).toEqual(["new-first", "new-after-known"]);
    expect(setup.state.sourceAgentIds).toEqual([3314]);
  });

  it("incremental reads newest page for persisted sources", async () => {
    const setup = harness({ state: { sourceAgentIds: [3314] } });

    await runPredictions(setup.deps, { scan: "incremental", targetAgentId: 900 });

    expect(setup.requestedSources[0]).toBe(3314);
  });

  it("uses before cursor from the previous predictions page", async () => {
    const setup = harness();

    await runPredictions(setup.deps, { scan: "full", targetAgentId: 900 });

    expect(setup.deps.api.listAgentPredictions).toHaveBeenNthCalledWith(1, {
      sourceAgentId: 3314,
      chainId: 16661,
      limit: 20,
      before: undefined,
    });
    expect(setup.deps.api.listAgentPredictions).toHaveBeenNthCalledWith(2, {
      sourceAgentId: 3314,
      chainId: 16661,
      limit: 20,
      before: 202,
    });
  });

  it("marks a source agent completed only after all prediction pages finish", async () => {
    const setup = harness({ now: 10_000 });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.state.predictionScanStartedAt).toBe(10_000);
    expect(setup.state.completedPredictionSourceIds).toEqual([3314]);
  });

  it("skips source agents completed in the active scan window", async () => {
    const setup = harness({
      state: {
        sourceAgentIds: [3314, 60062],
        completedPredictionSourceIds: [3314],
        predictionScanStartedAt: 10_000,
      },
      now: 20_000,
    });
    setup.predictionPages.set(60062, [page([prediction("fresh-60062", 60062)], null)]);

    await expect(
      runPredictions(setup.deps, { scan: "incremental", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.requestedSources).toEqual([60062]);
    expect(setup.submitted).toEqual(["fresh-60062"]);
    expect(setup.state.completedPredictionSourceIds).toEqual([3314, 60062]);
  });

  it("deduplicates predictions by opinion id, not shared market prediction id", async () => {
    const setup = harness({
      state: {
        sourceAgentIds: [3314, 60062],
        predictionScanStartedAt: 10_000,
      },
    });
    setup.predictionPages.set(3314, [page([prediction("shared-market", 101)], null)]);
    setup.predictionPages.set(60062, [page([prediction("shared-market", 202)], null)]);

    await expect(
      runPredictions(setup.deps, { scan: "incremental", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.submitted).toEqual(["shared-market", "shared-market"]);
  });

  it("starts a new prediction source scan window after 24 hours from scan start", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const setup = harness({
      state: {
        sourceAgentIds: [3314],
        completedPredictionSourceIds: [3314],
        predictionScanStartedAt: 50_000,
      },
      now: 50_000 + dayMs,
    });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.requestedSources).toEqual([3314, 3314]);
    expect(setup.state.predictionScanStartedAt).toBe(50_000 + dayMs);
    expect(setup.state.completedPredictionSourceIds).toEqual([3314]);
  });

  it("waits before each predictions read request", async () => {
    const setup = harness({ predictionReadCooldownSeconds: 2 });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.sleep).toHaveBeenCalledTimes(2);
    expect(setup.sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(setup.sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("returns rate_limited when reading predictions hits the API limit", async () => {
    const setup = harness();
    const updates: PredictionProgressUpdate[] = [];
    setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
    setup.deps.api.listAgentPredictions.mockImplementation(async () => {
      throw new EvoEvoHttpError(
        "EvoEvo API GET https://api.evoevo.ai/v1/agents/6714/predictions -> 429 : {\"error\":\"rate limit exceeded\"}",
        429,
        true,
      );
    });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 900_000 });

    expect(setup.state.completedPredictionSourceIds).toEqual([]);
    expect(updates).toContainEqual({
      activity: {
        type: "predictions-rate-limited",
        retryAfterMs: 900_000,
        sourceAgentId: 3314,
      },
    });
  });

  it("rejects a target that is not owned by the wallet", async () => {
    const setup = harness();

    await expect(runPredictions(setup.deps, { scan: "full", targetAgentId: 999 })).resolves.toEqual({
      kind: "failed",
      reason: "Prediction target is not owned by this wallet",
      global: true,
    });
  });

  it("logs and continues after an already-adopted prediction", async () => {
    const setup = harness();
    setup.predictionPages.set(3314, [
      page([prediction("already", 1), prediction("fresh", 2)], null),
    ]);
    const updates: PredictionProgressUpdate[] = [];
    setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
    setup.deps.submitPrediction = vi.fn(async (
      _sourceAgentId: number,
      _targetAgentId: number,
      item: AgentPrediction,
    ) => item.predictionId === "already"
      ? { kind: "already_adopted" as const }
      : { kind: "approved" as const, txHash: "0xfresh" });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.deps.submitPrediction).toHaveBeenCalledTimes(2);
    expect(await setup.deps.registry.has("1")).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      skippedDelta: 1,
      activity: {
        type: "prediction",
        phase: "already_adopted",
        sourceAgentId: 3314,
        targetAgentId: 900,
        predictionId: "already",
      },
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      addedDelta: 1,
      activity: expect.objectContaining({
        type: "prediction",
        phase: "confirmed",
        txHash: "0xfresh",
      }),
    }));
  });

  it("returns rate_limited when prediction submission hits a memory API limit", async () => {
    const setup = harness();
    setup.predictionPages.set(3314, [
      page([prediction("limited", 1)], null),
    ]);
    const updates: PredictionProgressUpdate[] = [];
    setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
    setup.deps.submitPrediction = vi.fn(async () => ({
      kind: "rate_limited" as const,
      retryAfterMs: 900_000,
    }));

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 900_000 });

    expect(updates).toContainEqual({
      activity: {
        type: "predictions-rate-limited",
        retryAfterMs: 900_000,
        sourceAgentId: 3314,
      },
    });
  });

  it("skips predictions already intaken by the viewer without submitting", async () => {
    const setup = harness();
    setup.predictionPages.set(3314, [
      page([prediction("already-viewed", 1, true), prediction("fresh", 2)], null),
    ]);
    const updates: PredictionProgressUpdate[] = [];
    setup.deps.onProgress = vi.fn(async (update) => { updates.push(update); });
    setup.deps.submitPrediction = vi.fn(async (
      _sourceAgentId: number,
      _targetAgentId: number,
      item: AgentPrediction,
    ) => {
      setup.submitted.push(item.predictionId);
      return { kind: "approved" as const, txHash: `0x${item.opinionId}` };
    });

    await expect(
      runPredictions(setup.deps, { scan: "full", targetAgentId: 900 }),
    ).resolves.toEqual({ kind: "completed" });

    expect(setup.deps.submitPrediction).toHaveBeenCalledTimes(1);
    expect(setup.submitted).toEqual(["fresh"]);
    expect(await setup.deps.registry.has("1")).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      skippedDelta: 1,
      activity: {
        type: "prediction",
        phase: "skipped",
        sourceAgentId: 3314,
        targetAgentId: 900,
        predictionId: "already-viewed",
        reason: "viewer_has_intaken",
      },
    }));
  });
});
