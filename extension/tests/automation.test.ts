// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { runAutomation, type Outcome } from "../src/content/automation.js";
import { buildFeedDom } from "./fixtures/dom-feed.js";

describe("automation loop", () => {
  it("clicks every visible ADD TO MEMORY button then stops", async () => {
    buildFeedDom(3);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));
    const events: string[] = [];

    await runAutomation({
      nextOutcome,
      onEvent: (event) => events.push(event.type),
    });

    expect(nextOutcome).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toBe("done");
  });

  it("does not re-click an already-attempted button", async () => {
    buildFeedDom(2);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));
    await runAutomation({ nextOutcome, onEvent: () => undefined });
    const markers = document.querySelectorAll("[data-auto-evoevo-attempted-id]");
    expect(markers.length).toBe(2);
  });

  it("pauses on rpc rejection and stops further clicks", async () => {
    buildFeedDom(3);
    let calls = 0;
    const nextOutcome = vi.fn(async (): Promise<Outcome> => {
      calls += 1;
      if (calls === 2) return { ok: false, error: { code: 4001, message: "rejected" } };
      return { ok: true, txHash: "0xtx" };
    });
    const events: string[] = [];

    await runAutomation({
      nextOutcome,
      onEvent: (event) => events.push(event.type),
    });

    expect(nextOutcome).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("paused");
  });

  it("clicks SHOW MORE when no visible buttons and stops after 2 unproductive expansions", async () => {
    buildFeedDom(0, true);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));
    const events: string[] = [];
    await runAutomation({
      nextOutcome,
      onEvent: (event) => events.push(event.type),
    });
    expect(events.at(-1)).toBe("done");
  });
});
