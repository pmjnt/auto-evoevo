import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionLogger } from "../src/logger.js";
import type { AttemptLog } from "../src/types.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("SessionLogger", () => {
  it("records attempts and summarizes statuses", () => {
    tempDir = mkdtempSync(join(tmpdir(), "auto-evoevo-logger-"));
    const logger = new SessionLogger(tempDir);
    const entry: AttemptLog = {
      timestamp: "2026-05-21T00:00:00.000Z",
      evoevoUrl: "https://evoevo.ai/feed",
      cardLabel: "Will Bitcoin reach 87000?",
      buttonIndex: 0,
      walletRequest: null,
      decision: null,
      status: "dry_run",
      reason: "Dry run",
    };

    logger.record(entry);

    expect(logger.summary()).toEqual({
      signed: 0,
      skipped: 0,
      failed: 0,
      manual_review: 0,
      dry_run: 1,
    });
    expect(readFileSync(logger.filePath, "utf8")).toContain(
      '"status":"dry_run"',
    );
  });

  it("does not count attempts that fail to persist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "auto-evoevo-logger-"));
    const logger = new SessionLogger(tempDir);
    const entry: AttemptLog = {
      timestamp: "2026-05-21T00:00:00.000Z",
      evoevoUrl: "https://evoevo.ai/feed",
      cardLabel: "Will Bitcoin reach 87000?",
      buttonIndex: 0,
      walletRequest: null,
      decision: null,
      status: "dry_run",
      reason: "Dry run",
    };

    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;

    expect(() => logger.record(entry)).toThrow();
    expect(logger.summary()).toEqual({
      signed: 0,
      skipped: 0,
      failed: 0,
      manual_review: 0,
      dry_run: 0,
    });
  });
});
