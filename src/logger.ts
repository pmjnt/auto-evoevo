import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AttemptLog, AttemptStatus } from "./types.js";

type Summary = Record<AttemptStatus, number>;

export class SessionLogger {
  public readonly filePath: string;

  private counts: Summary = {
    signed: 0,
    skipped: 0,
    failed: 0,
    manual_review: 0,
    dry_run: 0,
  };

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(logDir, `session-${timestamp}.jsonl`);
  }

  record(entry: AttemptLog): void {
    this.counts[entry.status] += 1;
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  summary(): Summary {
    return { ...this.counts };
  }
}
