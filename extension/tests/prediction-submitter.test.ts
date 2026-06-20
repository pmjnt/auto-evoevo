import { describe, expect, it, vi } from "vitest";
import { EvoEvoHttpError } from "../src/background/evoevo-api.js";
import { preparePredictionIntake } from "../src/background/prediction-submitter.js";

describe("preparePredictionIntake", () => {
  it("logs and returns already_adopted for the exact semantic conflict", async () => {
    const append = vi.fn(async () => undefined);
    const api = {
      memoryFromOpinion: vi.fn(async () => {
        throw new EvoEvoHttpError("already adopted", 409, false, {
          error: "already adopted",
        });
      }),
    };

    await expect(preparePredictionIntake({
      api,
      log: { append },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).resolves.toEqual({ kind: "already_adopted" });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped",
      reason: "Predictions source 3314 prediction 859: already adopted",
    }));
  });

  it("rethrows unrelated conflicts", async () => {
    const error = new EvoEvoHttpError("other", 409, false, { error: "other" });
    await expect(preparePredictionIntake({
      api: { memoryFromOpinion: vi.fn(async () => { throw error; }) },
      log: { append: vi.fn(async () => undefined) },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).rejects.toBe(error);
  });
});
