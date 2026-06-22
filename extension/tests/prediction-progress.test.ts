import { describe, expect, it, vi } from "vitest";
import { recordPredictionProgress } from "../src/background/prediction-progress.js";
import { DEFAULT_WORKFLOW_STATE } from "../src/background/storage.js";

describe("recordPredictionProgress", () => {
  it("persists deltas and broadcasts activity", async () => {
    let state = structuredClone(DEFAULT_WORKFLOW_STATE);
    const sendEvent = vi.fn();

    await recordPredictionProgress({
      sourceAgents: 20,
      scannedDelta: 1,
      skippedDelta: 1,
      activity: {
        type: "prediction",
        phase: "already_adopted",
        sourceAgentId: 3314,
        targetAgentId: 8359,
        predictionId: "859",
      },
    }, {
      getState: async () => state,
      setState: async (next) => { state = structuredClone(next); },
      sendEvent,
    });

    expect(state.counters).toMatchObject({
      sourceAgents: 20,
      predictionsScanned: 1,
      skipped: 1,
    });
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "already_adopted",
    }));
  });
});
