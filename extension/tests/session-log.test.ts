import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { SessionLog, LOG_CAP } from "../src/background/session-log.js";
import type { AttemptLog } from "../src/shared/types.js";

function makeEntry(status: AttemptLog["status"] = "signed"): AttemptLog {
  return {
    timestamp: new Date().toISOString(),
    evoevoUrl: "https://evoevo.ai/feed",
    cardLabel: "card",
    buttonIndex: 0,
    walletRequest: null,
    decision: null,
    status,
    reason: "ok",
    txHash: status === "signed" ? "0xabc" : null,
  };
}

describe("session-log", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("appends entries and returns them", async () => {
    const log = new SessionLog();
    await log.append(makeEntry("signed"));
    await log.append(makeEntry("dry_run"));
    const entries = await log.entries();
    expect(entries.map((e) => e.status)).toEqual(["signed", "dry_run"]);
  });

  it("counts entries per status", async () => {
    const log = new SessionLog();
    await log.append(makeEntry("signed"));
    await log.append(makeEntry("signed"));
    await log.append(makeEntry("rejected"));
    const counts = await log.counts();
    expect(counts.signed).toBe(2);
    expect(counts.rejected).toBe(1);
  });

  it("rotates to keep at most LOG_CAP entries", async () => {
    const log = new SessionLog();
    for (let i = 0; i < LOG_CAP + 5; i += 1) {
      await log.append(makeEntry("signed"));
    }
    const entries = await log.entries();
    expect(entries.length).toBe(LOG_CAP);
  });
});
