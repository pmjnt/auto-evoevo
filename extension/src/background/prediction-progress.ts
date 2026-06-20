import type { PredictionProgressUpdate } from "./predictions-runner.js";
import type { WorkflowState } from "../shared/types.js";

export async function recordPredictionProgress(
  update: PredictionProgressUpdate,
  deps: {
    getState: () => Promise<WorkflowState>;
    setState: (state: WorkflowState) => Promise<void>;
    sendEvent: (event: NonNullable<PredictionProgressUpdate["activity"]>) => void;
  },
): Promise<void> {
  const state = await deps.getState();
  if (update.sourceAgents !== undefined) state.counters.sourceAgents = update.sourceAgents;
  state.counters.predictionsScanned += update.scannedDelta ?? 0;
  state.counters.added += update.addedDelta ?? 0;
  state.counters.skipped += update.skippedDelta ?? 0;
  state.counters.failed += update.failedDelta ?? 0;
  await deps.setState(state);
  if (update.activity) deps.sendEvent(update.activity);
}
