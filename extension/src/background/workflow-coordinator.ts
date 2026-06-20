import type {
  ExtensionConfig,
  WorkflowMode,
  WorkflowState,
} from "../shared/types.js";
import type { PredictionScan } from "./predictions-runner.js";
import type { RunnerResult } from "./direct-runner.js";

export const WORKFLOW_ALARM_NAME = "workflow-cycle";

export type WorkflowCoordinatorDeps = {
  getConfig: () => Promise<ExtensionConfig | null>;
  getState: () => Promise<WorkflowState>;
  setState: (state: WorkflowState) => Promise<void>;
  runFeed: () => Promise<RunnerResult>;
  runPredictions: (
    targetAgentId: number,
    scan: PredictionScan,
  ) => Promise<RunnerResult>;
  now?: () => number;
};

export class WorkflowCoordinator {
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private pauseRequested = false;

  constructor(private readonly deps: WorkflowCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async start(mode: WorkflowMode): Promise<{ started: boolean }> {
    const state = await this.deps.getState();
    state.mode = mode;
    state.status = "running";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    state.lastError = null;
    await this.deps.setState(state);
    this.pauseRequested = false;
    this.launchCycle();
    return { started: true };
  }

  async pause(): Promise<void> {
    const state = await this.deps.getState();
    state.status = "paused";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    await this.deps.setState(state);
    this.pauseRequested = true;
    await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
  }

  async status(): Promise<WorkflowState> {
    return await this.deps.getState();
  }

  async recover(): Promise<void> {
    const state = await this.deps.getState();
    if (state.status !== "running") return;
    if (state.nextRunAt !== null && state.nextRunAt > this.now()) {
      await chrome.alarms.create(WORKFLOW_ALARM_NAME, { when: state.nextRunAt });
      return;
    }
    this.launchCycle();
  }

  async handleAlarm(name: string): Promise<void> {
    if (name !== WORKFLOW_ALARM_NAME) return;
    this.launchCycle();
  }

  async idle(): Promise<void> {
    await this.running;
  }

  isPaused(): boolean {
    return this.pauseRequested;
  }

  private launchCycle(): void {
    if (this.running !== null) return;
    this.running = this.runCycle().finally(() => {
      this.running = null;
    });
  }

  private async runCycle(): Promise<void> {
    const config = await this.deps.getConfig();
    if (config === null) {
      await this.pauseWithError("Extension not configured");
      return;
    }
    let state = await this.deps.getState();
    if (state.status !== "running" || state.mode === null) return;
    this.pauseRequested = false;

    if (state.mode === "feed" || state.mode === "both") {
      state.activeWorkflow = "feed";
      await this.deps.setState(state);
      const result = await this.deps.runFeed();
      if (result.kind === "paused") {
        await this.pause();
        return;
      }
      if (result.kind === "failed" && result.global) {
        await this.pauseWithError(result.reason);
        return;
      }
    }

    state = await this.deps.getState();
    if (state.status !== "running") return;
    if (state.mode === "predictions" || state.mode === "both") {
      state.activeWorkflow = "predictions";
      await this.deps.setState(state);
      const scan = fullScanDue(state, config, this.now()) ? "full" : "incremental";
      const result = await this.deps.runPredictions(config.agentId, scan);
      if (result.kind === "paused") {
        await this.pause();
        return;
      }
      if (result.kind === "failed" && result.global) {
        await this.pauseWithError(result.reason);
        return;
      }
      state = await this.deps.getState();
      if (scan === "full") state.lastReconciliationAt = this.now();
      state.lastIncrementalAt = this.now();
      await this.deps.setState(state);
    }

    await this.scheduleNext(config);
  }

  private async scheduleNext(config: ExtensionConfig): Promise<void> {
    const state = await this.deps.getState();
    if (state.status !== "running") return;
    state.activeWorkflow = null;
    state.nextRunAt = this.now() + config.repeatIntervalMinutes * 60_000;
    await this.deps.setState(state);
    await chrome.alarms.create(WORKFLOW_ALARM_NAME, { when: state.nextRunAt });
  }

  private async pauseWithError(reason: string): Promise<void> {
    const state = await this.deps.getState();
    state.status = "paused";
    state.activeWorkflow = null;
    state.nextRunAt = null;
    state.lastError = reason;
    await this.deps.setState(state);
    await chrome.alarms.clear(WORKFLOW_ALARM_NAME);
  }
}

function fullScanDue(
  state: WorkflowState,
  config: ExtensionConfig,
  now: number,
): boolean {
  return state.lastReconciliationAt === null ||
    now - state.lastReconciliationAt >= config.reconciliationIntervalMinutes * 60_000;
}
