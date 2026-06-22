import type { EvoEvoApiClient, FromOpinionResponse } from "./evoevo-api.js";
import { EvoEvoHttpError, isAlreadyAdoptedError } from "./evoevo-api.js";
import { makeAttemptLog } from "./intake-submitter.js";
import type { AttemptLog, ExtensionConfig } from "../shared/types.js";

export type PreparedPredictionIntake =
  | { kind: "ready"; memory: FromOpinionResponse }
  | { kind: "already_adopted" }
  | { kind: "rate_limited"; retryAfterMs: number };

export async function preparePredictionIntake(args: {
  api: Pick<EvoEvoApiClient, "memoryFromOpinion">;
  config: Pick<ExtensionConfig, "memoryApiCooldownSeconds" | "rateLimitBackoffMinutes">;
  sleep?: (ms: number) => Promise<void>;
  log: { append: (entry: AttemptLog) => Promise<void> };
  sourceAgentId: number;
  targetAgentId: number;
  predictionId: string;
  opinionId: number;
}): Promise<PreparedPredictionIntake> {
  try {
    const delayMs = Math.max(0, args.config.memoryApiCooldownSeconds) * 1000;
    if (delayMs > 0) await (args.sleep ?? sleep)(delayMs);
    const memory = await args.api.memoryFromOpinion(args.targetAgentId, args.opinionId);
    return { kind: "ready", memory };
  } catch (error) {
    if (isAlreadyAdoptedError(error)) {
      await args.log.append(makeAttemptLog({
        status: "skipped",
        reason: `Predictions source ${args.sourceAgentId} prediction ${args.predictionId}: already adopted`,
      }));
      return { kind: "already_adopted" };
    }
    if (isRateLimitError(error)) {
      return {
        kind: "rate_limited",
        retryAfterMs: Math.max(1, args.config.rateLimitBackoffMinutes) * 60_000,
      };
    }
    throw error;
  }
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof EvoEvoHttpError && error.status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
