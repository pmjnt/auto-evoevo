// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { runAutomation, type Outcome } from "../src/content/automation.js";
import { buildFeedDom } from "./fixtures/dom-feed.js";

describe("automation loop", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
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

  it("waits briefly before requesting a reload when a submitting modal appears", async () => {
    vi.useFakeTimers();
    buildFeedDom(2);
    const buttons = Array.from(document.querySelectorAll("button"));
    const firstButton = buttons[0] as HTMLButtonElement;
    const secondButton = buttons[1] as HTMLButtonElement;
    const modal = document.createElement("div");
    const clicked: string[] = [];
    const events: string[] = [];

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
      modalRefreshDelayMs: 1_000,
      onEvent: (event) => events.push(event.type),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(events).toEqual(["started", "clicked", "approved"]);

    await vi.advanceTimersByTimeAsync(1);
    await runPromise;

    expect(clicked).toEqual(["first"]);
    expect(events).toEqual(["started", "clicked", "approved", "reload_requested"]);
  });

  it("waits for feed controls to appear after a reload before declaring done", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));

    const runPromise = runAutomation({
      nextOutcome,
      emptyFeedTimeoutMs: 1_000,
      onEvent: (event) => events.push(event.type),
    });

    await vi.advanceTimersByTimeAsync(500);
    buildFeedDom(1);
    await vi.runOnlyPendingTimersAsync();
    await runPromise;

    expect(nextOutcome).toHaveBeenCalledTimes(1);
    expect(events).toContain("clicked");
    expect(events.at(-1)).toBe("done");
  });

  it("stops when remaining items are at or below the buffer and show more is unavailable", async () => {
    buildFeedDom(1);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));
    const events: string[] = [];

    await runAutomation({
      nextOutcome,
      stopAtRemaining: 1,
      onEvent: (event) => events.push(event.type),
    });

    expect(nextOutcome).not.toHaveBeenCalled();
    expect(events).toEqual(["started", "done"]);
  });

  it("keeps running at the buffer while show more is still available", async () => {
    buildFeedDom(2, true);
    const showMore = Array.from(document.querySelectorAll("button")).find((button) =>
      /show more/i.test(button.textContent ?? ""),
    ) as HTMLButtonElement;
    showMore.addEventListener("click", () => {
      showMore.remove();
      const article = document.createElement("article");
      const button = document.createElement("button");
      button.textContent = "ADD TO MEMORY";
      article.append(button);
      document.body.append(article);
    });
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));

    await runAutomation({
      nextOutcome,
      stopAtRemaining: 1,
      onEvent: () => undefined,
    });

    const unmarked = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        /add to memory/i.test(button.textContent ?? "") &&
        !button.hasAttribute("data-auto-evoevo-attempted-id"),
    );
    expect(nextOutcome).toHaveBeenCalledTimes(2);
    expect(unmarked).toHaveLength(1);
  });

  it("does not stop at the buffer when show more is a non-button control", async () => {
    buildFeedDom(1);
    const showMore = document.createElement("div");
    showMore.setAttribute("role", "button");
    showMore.textContent = "SHOW MORE";
    showMore.addEventListener("click", () => {
      showMore.remove();
      const article = document.createElement("article");
      const button = document.createElement("button");
      button.textContent = "ADD TO MEMORY";
      article.append(button);
      document.body.append(article);
    });
    document.body.append(showMore);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));

    await runAutomation({
      nextOutcome,
      stopAtRemaining: 1,
      onEvent: () => undefined,
    });

    expect(nextOutcome).toHaveBeenCalledTimes(1);
  });

  it("clicks add-to-memory controls rendered without a button tag", async () => {
    const control = document.createElement("div");
    control.setAttribute("role", "button");
    control.textContent = "ADD TO MEMORY";
    document.body.append(control);
    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));

    await runAutomation({
      nextOutcome,
      onEvent: () => undefined,
    });

    expect(nextOutcome).toHaveBeenCalledTimes(1);
    expect(control.hasAttribute("data-auto-evoevo-attempted-id")).toBe(true);
  });

  it("only matches exact add-to-memory and show-more labels", async () => {
    const wrongMemory = document.createElement("button");
    wrongMemory.textContent = "ADD TO MEMORY 122";
    const wrongShowMore = document.createElement("button");
    wrongShowMore.textContent = "SHOW MORE RESULTS";
    const memory = document.createElement("button");
    memory.textContent = "ADD TO MEMORY";
    const showMore = document.createElement("button");
    showMore.textContent = "SHOW MORE";
    document.body.append(wrongMemory, wrongShowMore, memory, showMore);

    const nextOutcome = vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" }));

    await runAutomation({
      nextOutcome,
      stopAtRemaining: 1,
      onEvent: () => undefined,
    });

    expect(nextOutcome).toHaveBeenCalledTimes(1);
    expect(wrongMemory.hasAttribute("data-auto-evoevo-attempted-id")).toBe(false);
    expect(memory.hasAttribute("data-auto-evoevo-attempted-id")).toBe(true);
  });

  it("does not wait on a hidden retained submitting modal", async () => {
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
      modal.style.display = "none";
      document.body.append(modal);
    });
    secondButton.addEventListener("click", () => {
      clicked.push("second");
    });

    await runAutomation({
      nextOutcome: vi.fn(async (): Promise<Outcome> => ({ ok: true, txHash: "0xtx" })),
      onEvent: () => undefined,
    });

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
