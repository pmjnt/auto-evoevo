import type { Agent, EvoEvoApiClient } from "./evoevo-api.js";
import type { RunnerResult } from "./direct-runner.js";

export type FeedWorkflowDeps = {
  api: Pick<EvoEvoApiClient, "listAgents">;
  walletAddress: string;
  chainId: number;
  runAgent: (agentId: number) => Promise<RunnerResult>;
  isPaused: () => boolean;
  onProgress: (progress: {
    ownedAgents: number;
    completed: number;
    activeAgentId: number | null;
  }) => void;
};

export async function runFeedWorkflow(
  deps: FeedWorkflowDeps,
): Promise<RunnerResult> {
  const agents = await deps.api.listAgents(deps.walletAddress, deps.chainId);
  deps.onProgress({ ownedAgents: agents.length, completed: 0, activeAgentId: null });

  let completed = 0;
  for (const agent of agents) {
    if (deps.isPaused()) return { kind: "paused" };
    deps.onProgress({ ownedAgents: agents.length, completed, activeAgentId: agent.id });
    const result = await deps.runAgent(agent.id);
    completed += 1;
    deps.onProgress({ ownedAgents: agents.length, completed, activeAgentId: null });

    if (result.kind === "paused") return result;
    if (result.kind === "failed" && result.global) return result;
  }
  return { kind: "completed" };
}

export function eligibleAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.active !== false);
}
