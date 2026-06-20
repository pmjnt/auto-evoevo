import { describe, expect, it, vi } from "vitest";
import { runFeedWorkflow } from "../src/background/feed-workflow.js";
import type { Agent } from "../src/background/evoevo-api.js";

const agents: Agent[] = [11, 22, 33].map((id) => ({
  id,
  name: `Agent ${id}`,
  active: true,
  onchain_identity: null,
}));

describe("Feed workflow", () => {
  it("runs every owned agent sequentially", async () => {
    const calls: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const result = await runFeedWorkflow({
      api: { listAgents: vi.fn(async () => agents) },
      walletAddress: "0x" + "11".repeat(20),
      chainId: 16661,
      runAgent: async (agentId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        calls.push(agentId);
        await Promise.resolve();
        concurrent -= 1;
        return { kind: "completed" };
      },
      isPaused: () => false,
      onProgress: () => undefined,
    });

    expect(result).toEqual({ kind: "completed" });
    expect(calls).toEqual([11, 22, 33]);
    expect(maxConcurrent).toBe(1);
  });

  it("stops before the next agent after Pause", async () => {
    const calls: number[] = [];
    let paused = false;
    const result = await runFeedWorkflow({
      api: { listAgents: vi.fn(async () => agents) },
      walletAddress: "0x" + "11".repeat(20),
      chainId: 16661,
      runAgent: async (agentId) => {
        calls.push(agentId);
        paused = true;
        return { kind: "completed" };
      },
      isPaused: () => paused,
      onProgress: () => undefined,
    });

    expect(result).toEqual({ kind: "paused" });
    expect(calls).toEqual([11]);
  });

  it("continues after an agent-local failure", async () => {
    const calls: number[] = [];
    const result = await runFeedWorkflow({
      api: { listAgents: vi.fn(async () => agents) },
      walletAddress: "0x" + "11".repeat(20),
      chainId: 16661,
      runAgent: async (agentId) => {
        calls.push(agentId);
        return agentId === 22
          ? { kind: "failed", reason: "reverted", global: false }
          : { kind: "completed" };
      },
      isPaused: () => false,
      onProgress: () => undefined,
    });

    expect(result).toEqual({ kind: "completed" });
    expect(calls).toEqual([11, 22, 33]);
  });
});
