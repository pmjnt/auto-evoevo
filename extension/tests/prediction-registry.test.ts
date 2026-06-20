import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { getWorkflowState, setPredictionIds } from "../src/background/storage.js";
import { ChromePredictionRegistry } from "../src/background/prediction-registry.js";

describe("prediction registry", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("does not replay a completed ID after the target changes", async () => {
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.complete("p-100");

    expect(await registry.has("p-100")).toBe(true);
    expect(await registry.claim("p-100")).toBe(false);
  });

  it("blocks an ambiguous ID from automatic replay", async () => {
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.block("p-101");

    expect(await registry.has("p-101")).toBe(true);
    expect(await registry.isBlocked("p-101")).toBe(true);
  });

  it("keeps retry target fixed to the target at discovery", async () => {
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.retry({
      predictionId: "p-102",
      opinionId: 55,
      sourceAgentId: 3314,
      targetAgentId: 700,
      attempts: 1,
      retryAfter: 123,
    });

    expect((await registry.dueRetries(123))[0]!.targetAgentId).toBe(700);
  });

  it("deduplicates page completions and reports storage size", async () => {
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.completePage(["p-2", "p-1", "p-2"]);

    expect(await registry.claim("p-1")).toBe(false);
    expect(await registry.storageBytes()).toBeGreaterThan(0);
  });

  it("caps exhausted retries as blocked failures", async () => {
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.retry({
      predictionId: "p-103",
      opinionId: 55,
      sourceAgentId: 3314,
      targetAgentId: 700,
      attempts: 5,
      retryAfter: 1,
    });

    expect(await registry.isBlocked("p-103")).toBe(true);
    expect(await registry.dueRetries(1)).toEqual([]);
  });

  it("does not drop existing IDs when completing a new one", async () => {
    await setPredictionIds(["old"]);
    const registry = new ChromePredictionRegistry({ random: () => 0 });
    await registry.complete("new");

    expect(await registry.has("old")).toBe(true);
    expect(await registry.has("new")).toBe(true);
    expect((await getWorkflowState()).retryQueue).toEqual([]);
  });
});
