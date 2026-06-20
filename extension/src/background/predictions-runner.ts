import type {
  AgentPrediction,
  ApiPage,
  EvoEvoApiClient,
  PageRequest,
  SquareAgent,
} from "./evoevo-api.js";
import type { SubmitOutcome } from "./intake-submitter.js";
import type { PredictionRegistry } from "./prediction-registry.js";
import type { RunnerResult } from "./direct-runner.js";
import type {
  PredictionActivityEvent,
  WorkflowState,
} from "../shared/types.js";

export type PredictionScan = "incremental" | "full";

export type PredictionProgressUpdate = {
  sourceAgents?: number;
  scannedDelta?: number;
  addedDelta?: number;
  skippedDelta?: number;
  failedDelta?: number;
  activity?: PredictionActivityEvent;
};

export type PredictionsRunnerDeps = {
  api: Pick<
    EvoEvoApiClient,
    "listAgents" | "listSquareAgents" | "listAgentPredictions"
  >;
  walletAddress: string;
  chainId: number;
  registry: PredictionRegistry;
  checkpoint: {
    load: () => Promise<WorkflowState>;
    save: (state: WorkflowState) => Promise<void>;
  };
  submitPrediction: (
    sourceAgentId: number,
    targetAgentId: number,
    prediction: AgentPrediction,
  ) => Promise<SubmitOutcome>;
  isPaused: () => boolean;
  onProgress: (update: PredictionProgressUpdate) => Promise<void>;
};

export async function runPredictions(
  deps: PredictionsRunnerDeps,
  args: { targetAgentId: number; scan: PredictionScan },
): Promise<RunnerResult> {
  const ownedAgents = await deps.api.listAgents(deps.walletAddress, deps.chainId);
  if (!ownedAgents.some((agent) => agent.id === args.targetAgentId)) {
    return {
      kind: "failed",
      reason: "Prediction target is not owned by this wallet",
      global: true,
    };
  }

  const retryResult = await processDueRetries(deps);
  if (retryResult.kind !== "completed") return retryResult;

  await deps.onProgress({ activity: { type: "predictions-loading" } });
  const sourceAgentIds = args.scan === "full"
    ? await collectAllSourceAgents(deps)
    : await collectIncrementalSourceAgents(deps);
  await deps.onProgress({
    sourceAgents: sourceAgentIds.length,
    activity: { type: "predictions-sources", count: sourceAgentIds.length },
  });

  for (const sourceAgentId of sourceAgentIds) {
    if (deps.isPaused()) return { kind: "paused" };
    const result = await processSource(deps, {
      sourceAgentId,
      targetAgentId: args.targetAgentId,
      full: args.scan === "full",
    });
    if (result.kind !== "completed") return result;
  }

  return { kind: "completed" };
}

async function collectAllSourceAgents(deps: PredictionsRunnerDeps): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  const seenFingerprints = new Set<string>();
  while (true) {
    const page = await deps.api.listSquareAgents({
      chainId: deps.chainId,
      limit: 20,
      cursor,
    });
    assertFreshPage(seenFingerprints, page, "square/feed");
    ids.push(...page.items.map((agent) => agent.id));
    const state = await deps.checkpoint.load();
    state.sourceAgentIds = uniqueNumbers(ids);
    await deps.checkpoint.save(state);
    if (!page.next?.cursor) break;
    cursor = page.next.cursor;
  }
  return uniqueNumbers(ids);
}

async function collectIncrementalSourceAgents(deps: PredictionsRunnerDeps): Promise<number[]> {
  const state = await deps.checkpoint.load();
  const latest = await deps.api.listSquareAgents({ chainId: deps.chainId, limit: 20 });
  const ids = uniqueNumbers([
    ...state.sourceAgentIds,
    ...latest.items.map((agent) => agent.id),
  ]);
  state.sourceAgentIds = ids;
  await deps.checkpoint.save(state);
  return ids;
}

async function processSource(
  deps: PredictionsRunnerDeps,
  args: { sourceAgentId: number; targetAgentId: number; full: boolean },
): Promise<RunnerResult> {
  let offset = 0;
  const seenFingerprints = new Set<string>();
  while (true) {
    const page = await deps.api.listAgentPredictions({
      sourceAgentId: args.sourceAgentId,
      chainId: deps.chainId,
      limit: 20,
      offset,
    });
    assertFreshPage(seenFingerprints, page, `predictions:${args.sourceAgentId}`);
    let sawUnknown = false;
    const completed: string[] = [];

    for (const prediction of page.items) {
      if (deps.isPaused()) return { kind: "paused" };
      await deps.onProgress({ scannedDelta: 1 });
      if (await deps.registry.has(prediction.predictionId)) continue;
      sawUnknown = true;
      const context = {
        sourceAgentId: args.sourceAgentId,
        targetAgentId: args.targetAgentId,
        predictionId: prediction.predictionId,
      };
      await deps.onProgress({
        activity: { type: "prediction", phase: "submitting", ...context },
      });
      const outcome = await deps.submitPrediction(
        args.sourceAgentId,
        args.targetAgentId,
        prediction,
      );
      if (outcome.kind === "approved") {
        completed.push(prediction.predictionId);
        await deps.onProgress({
          addedDelta: 1,
          activity: {
            type: "prediction",
            phase: "confirmed",
            ...context,
            txHash: outcome.txHash,
          },
        });
      } else if (outcome.kind === "already_adopted") {
        await deps.registry.complete(prediction.predictionId);
        await deps.onProgress({
          skippedDelta: 1,
          activity: {
            type: "prediction",
            phase: "already_adopted",
            ...context,
          },
        });
      } else if (outcome.kind === "dry_run") {
        continue;
      } else if (outcome.kind === "ambiguous") {
        await deps.registry.block(prediction.predictionId);
        await deps.onProgress({
          failedDelta: 1,
          activity: {
            type: "prediction",
            phase: "failed",
            ...context,
            reason: outcome.reason,
          },
        });
        return { kind: "failed", reason: outcome.reason, global: true };
      } else if (outcome.retryable) {
        await deps.registry.retry({
          predictionId: prediction.predictionId,
          opinionId: prediction.opinionId,
          sourceAgentId: args.sourceAgentId,
          targetAgentId: args.targetAgentId,
          attempts: 1,
          retryAfter: Date.now() + 30_000,
        });
        await deps.onProgress({
          failedDelta: 1,
          activity: {
            type: "prediction",
            phase: "failed",
            ...context,
            reason: outcome.reason,
          },
        });
      } else {
        completed.push(prediction.predictionId);
        await deps.onProgress({
          skippedDelta: 1,
          activity: {
            type: "prediction",
            phase: "skipped",
            ...context,
            reason: outcome.reason,
          },
        });
      }
    }

    if (completed.length > 0) await deps.registry.completePage(completed);
    const state = await deps.checkpoint.load();
    state.predictionOffsets[String(args.sourceAgentId)] = page.next?.offset ?? 0;
    await deps.checkpoint.save(state);

    if (!page.next?.offset) break;
    if (!args.full && !sawUnknown) break;
    offset = page.next.offset;
  }
  return { kind: "completed" };
}

async function processDueRetries(deps: PredictionsRunnerDeps): Promise<RunnerResult> {
  const due = await deps.registry.dueRetries(Date.now());
  for (const item of due) {
    if (deps.isPaused()) return { kind: "paused" };
    const context = {
      sourceAgentId: item.sourceAgentId,
      targetAgentId: item.targetAgentId,
      predictionId: item.predictionId,
    };
    await deps.onProgress({
      activity: { type: "prediction", phase: "submitting", ...context },
    });
    const outcome = await deps.submitPrediction(
      item.sourceAgentId,
      item.targetAgentId,
      {
        predictionId: item.predictionId,
        opinionId: item.opinionId,
        createdAt: "",
      },
    );
    if (outcome.kind === "approved") {
      await deps.registry.complete(item.predictionId);
      await deps.registry.removeRetry(item.predictionId);
      await deps.onProgress({
        addedDelta: 1,
        activity: {
          type: "prediction",
          phase: "confirmed",
          ...context,
          txHash: outcome.txHash,
        },
      });
    } else if (outcome.kind === "already_adopted") {
      await deps.registry.complete(item.predictionId);
      await deps.registry.removeRetry(item.predictionId);
      await deps.onProgress({
        skippedDelta: 1,
        activity: {
          type: "prediction",
          phase: "already_adopted",
          ...context,
        },
      });
    } else if (outcome.kind === "ambiguous") {
      await deps.registry.block(item.predictionId);
      await deps.onProgress({
        failedDelta: 1,
        activity: {
          type: "prediction",
          phase: "failed",
          ...context,
          reason: outcome.reason,
        },
      });
      return { kind: "failed", reason: outcome.reason, global: true };
    } else if (outcome.kind === "rejected" && outcome.retryable) {
      await deps.registry.retry({ ...item, attempts: item.attempts + 1 });
      await deps.onProgress({
        failedDelta: 1,
        activity: {
          type: "prediction",
          phase: "failed",
          ...context,
          reason: outcome.reason,
        },
      });
    } else if (outcome.kind === "rejected") {
      await deps.registry.complete(item.predictionId);
      await deps.registry.removeRetry(item.predictionId);
      await deps.onProgress({
        skippedDelta: 1,
        activity: {
          type: "prediction",
          phase: "skipped",
          ...context,
          reason: outcome.reason,
        },
      });
    }
  }
  return { kind: "completed" };
}

function assertFreshPage<T>(
  seen: Set<string>,
  page: ApiPage<T>,
  label: string,
): void {
  if (page.fingerprint !== "empty" && seen.has(page.fingerprint)) {
    throw new Error(`Repeated ${label} page: ${page.fingerprint}`);
  }
  seen.add(page.fingerprint);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
