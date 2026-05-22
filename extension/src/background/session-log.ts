import type { AttemptLog, AttemptStatus } from "../shared/types.js";

export const LOG_CAP = 1000;

type Counts = Record<AttemptStatus, number>;

const ZERO_COUNTS: Counts = {
  signed: 0,
  skipped: 0,
  failed: 0,
  manual_review: 0,
  dry_run: 0,
  rejected: 0,
  rejected_origin: 0,
  rpc_failed: 0,
  reverted: 0,
};

export class SessionLog {
  private readonly storageKey = "session-log";

  async append(entry: AttemptLog): Promise<void> {
    const current = await this.entries();
    const next = [...current, entry].slice(-LOG_CAP);
    await chrome.storage.local.set({ [this.storageKey]: next });
  }

  async entries(): Promise<AttemptLog[]> {
    const stored = await chrome.storage.local.get(this.storageKey);
    const value = (stored as Record<string, unknown>)[this.storageKey];
    return Array.isArray(value) ? (value as AttemptLog[]) : [];
  }

  async counts(): Promise<Counts> {
    const entries = await this.entries();
    const totals: Counts = { ...ZERO_COUNTS };
    for (const entry of entries) {
      totals[entry.status] = (totals[entry.status] ?? 0) + 1;
    }
    return totals;
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(this.storageKey);
  }
}
