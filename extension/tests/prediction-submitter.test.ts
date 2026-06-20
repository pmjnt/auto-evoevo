import { describe, expect, it, vi } from "vitest";
import { EvoEvoHttpError } from "../src/background/evoevo-api.js";
import type { FromOpinionResponse } from "../src/background/evoevo-api.js";
import { preparePredictionIntake } from "../src/background/prediction-submitter.js";

const config = {
  memoryApiCooldownSeconds: 1,
  rateLimitBackoffMinutes: 15,
};

describe("preparePredictionIntake", () => {
  it("waits before calling the memory API", async () => {
    const calls: string[] = [];
    const memory: FromOpinionResponse = {
      chain_action: "intake_reasoning",
      memory_id: 1,
      opinion_id: 4325811,
      reasoning_intake_with_sig: {
        chain_id: 16661,
        contract_address: "0x" + "ab".repeat(20),
        method: "intakeReasoningV2",
        identity_registry_address: "0x" + "cd".repeat(20),
        updater: "0x" + "ef".repeat(20),
        token_id: "4644",
        source_opinion_id: "4325811",
        reasoning_hash: "0x" + "11".repeat(32),
        opinion_hash: "0x" + "22".repeat(32),
        new_memory_root: "0x" + "33".repeat(32),
        nonce: "1",
        deadline: "2",
        expires_at: "2026-06-20T08:00:00Z",
        signature: "0x" + "44".repeat(65),
      },
      status: "prepared",
      target_agent_id: 8359,
      token_id: "4644",
    };
    const sleep = vi.fn(async (ms: number) => {
      calls.push(`sleep:${ms}`);
    });
    const api = {
      memoryFromOpinion: vi.fn(async () => {
        calls.push("memoryFromOpinion");
        return memory;
      }),
    };

    await expect(preparePredictionIntake({
      api,
      config,
      sleep,
      log: { append: vi.fn(async () => undefined) },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).resolves.toEqual({ kind: "ready", memory });

    expect(sleep).toHaveBeenCalledWith(1000);
    expect(calls).toEqual(["sleep:1000", "memoryFromOpinion"]);
  });

  it("returns rate_limited for exhausted memory API rate limits", async () => {
    const api = {
      memoryFromOpinion: vi.fn(async () => {
        throw new EvoEvoHttpError("rate", 429, true);
      }),
    };

    await expect(preparePredictionIntake({
      api,
      config,
      sleep: vi.fn(async () => undefined),
      log: { append: vi.fn(async () => undefined) },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 15 * 60_000 });
  });

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
      config,
      sleep: vi.fn(async () => undefined),
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
      config,
      sleep: vi.fn(async () => undefined),
      log: { append: vi.fn(async () => undefined) },
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
      opinionId: 4325811,
    })).rejects.toBe(error);
  });
});
