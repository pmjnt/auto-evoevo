// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { runAutomation, type Outcome } from "../src/content/automation.js";
import { buildFeedDom } from "./fixtures/dom-feed.js";

describe("automation loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("pauses when a click does not produce a transaction outcome", async () => {
    vi.useFakeTimers();
    buildFeedDom(2);
    const events: Array<{ type: string; reason?: string }> = [];

    const runPromise = runAutomation({
      nextOutcome: () => new Promise<Outcome>(() => undefined),
      outcomeTimeoutMs: 25,
      onEvent: (event) => events.push(event),
    });

    await vi.advanceTimersByTimeAsync(25);
    await runPromise;

    expect(events).toMatchObject([
      { type: "started" },
      { type: "clicked" },
      {
        type: "paused",
        reason: "Timed out waiting for transaction after click",
      },
    ]);
  });

  it("waits for the submitting modal to close before clicking the next item", async () => {
    vi.useFakeTimers();
    buildFeedDom(2);
    const buttons = Array.from(document.querySelectorAll("button"));
    const firstButton = buttons[0] as HTMLButtonElement;
    const secondButton = buttons[1] as HTMLButtonElement;
    const modal = document.createElement("div");
    const clicked: string[] = [];

    firstButton.addEventListener("click", () => {
      clicked.push("first");
      modal.textContent = "Submitting On-Chain Loading your agents...";
      document.body.append(modal);
    });
    secondButton.addEventListener("click", () => {
      clicked.push("second");
    });

    const runPromise = runAutomation({
      nextOutcome: vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" })),
      modalCloseTimeoutMs: 1_000,
      onEvent: () => undefined,
    });

    await Promise.resolve();
    expect(clicked).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(clicked).toEqual(["first"]);

    modal.remove();
    await vi.advanceTimersByTimeAsync(250);
    await runPromise;

    expect(clicked).toEqual(["first", "second"]);
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
