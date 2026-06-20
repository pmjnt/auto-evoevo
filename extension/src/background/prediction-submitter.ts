import type { EvoEvoApiClient, FromOpinionResponse } from "./evoevo-api.js";
import { isAlreadyAdoptedError } from "./evoevo-api.js";
import { makeAttemptLog } from "./intake-submitter.js";
import type { AttemptLog } from "../shared/types.js";

export type PreparedPredictionIntake =
  | { kind: "ready"; memory: FromOpinionResponse }
  | { kind: "already_adopted" };

export async function preparePredictionIntake(args: {
  api: Pick<EvoEvoApiClient, "memoryFromOpinion">;
  log: { append: (entry: AttemptLog) => Promise<void> };
  sourceAgentId: number;
  targetAgentId: number;
  predictionId: string;
  opinionId: number;
}): Promise<PreparedPredictionIntake> {
  try {
    const memory = await args.api.memoryFromOpinion(args.targetAgentId, args.opinionId);
    return { kind: "ready", memory };
  } catch (error) {
    if (!isAlreadyAdoptedError(error)) throw error;
    await args.log.append(makeAttemptLog({
      status: "skipped",
      reason: `Predictions source ${args.sourceAgentId} prediction ${args.predictionId}: already adopted`,
    }));
    return { kind: "already_adopted" };
  }
}
