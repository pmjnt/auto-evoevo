import {
  getPredictionIds,
  getWorkflowState,
  setPredictionIds,
  setWorkflowState,
} from "./storage.js";
import type { RetryItem } from "../shared/types.js";

export interface PredictionRegistry {
  has(predictionId: string): Promise<boolean>;
  claim(predictionId: string): Promise<boolean>;
  complete(predictionId: string): Promise<void>;
  completePage(predictionIds: string[]): Promise<void>;
  block(predictionId: string): Promise<void>;
  isBlocked(predictionId: string): Promise<boolean>;
  retry(item: RetryItem): Promise<void>;
  dueRetries(now: number): Promise<RetryItem[]>;
  removeRetry(predictionId: string): Promise<void>;
  storageBytes(): Promise<number>;
}

export class ChromePredictionRegistry implements PredictionRegistry {
  constructor(private readonly options: { random?: () => number } = {}) {}

  async has(predictionId: string): Promise<boolean> {
    const [ids, state] = await Promise.all([getPredictionIds(), getWorkflowState()]);
    return ids.includes(predictionId) || state.blockedPredictionIds.includes(predictionId);
  }

  async claim(predictionId: string): Promise<boolean> {
    return !(await this.has(predictionId));
  }

  async complete(predictionId: string): Promise<void> {
    await this.completePage([predictionId]);
  }

  async completePage(predictionIds: string[]): Promise<void> {
    const existing = await getPredictionIds();
    await setPredictionIds([...existing, ...predictionIds]);
  }

  async block(predictionId: string): Promise<void> {
    const state = await getWorkflowState();
    state.blockedPredictionIds = [...new Set([...state.blockedPredictionIds, predictionId])].sort();
    state.retryQueue = state.retryQueue.filter((item) => item.predictionId !== predictionId);
    await setWorkflowState(state);
  }

  async isBlocked(predictionId: string): Promise<boolean> {
    return (await getWorkflowState()).blockedPredictionIds.includes(predictionId);
  }

  async retry(item: RetryItem): Promise<void> {
    if (item.attempts >= 5) {
      await this.block(item.predictionId);
      return;
    }
    const state = await getWorkflowState();
    const retry = {
      ...item,
      retryAfter: item.retryAfter || Date.now() + retryDelayMs(item.attempts, this.options.random),
    };
    state.retryQueue = [
      ...state.retryQueue.filter((queued) => queued.predictionId !== item.predictionId),
      retry,
    ].sort((a, b) => a.retryAfter - b.retryAfter);
    await setWorkflowState(state);
  }

  async dueRetries(now: number): Promise<RetryItem[]> {
    return (await getWorkflowState()).retryQueue.filter((item) => item.retryAfter <= now);
  }

  async removeRetry(predictionId: string): Promise<void> {
    const state = await getWorkflowState();
    state.retryQueue = state.retryQueue.filter((item) => item.predictionId !== predictionId);
    await setWorkflowState(state);
  }

  async storageBytes(): Promise<number> {
    const [ids, state] = await Promise.all([getPredictionIds(), getWorkflowState()]);
    return JSON.stringify({ ids, blocked: state.blockedPredictionIds, retry: state.retryQueue }).length;
  }
}

function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** attempts);
  return base + Math.floor(base * 0.25 * Math.max(0, Math.min(1, random())));
}
