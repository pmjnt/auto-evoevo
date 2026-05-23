const MARKER = "data-auto-evoevo-attempted-id";
const IDLE_LIMIT = 2;

export type AutomationEvent =
  | { type: "started" }
  | { type: "clicked"; index: number }
  | { type: "approved"; txHash: string }
  | { type: "paused"; reason: string }
  | { type: "done" };

export type Outcome =
  | { ok: true; txHash: string }
  | { ok: false; error: { code: number; message: string } };

export type AutomationDeps = {
  nextOutcome: () => Promise<Outcome>;
  onEvent: (event: AutomationEvent) => void;
  cooldownMs?: number;
  // Stop when the count of unmarked ADD TO MEMORY buttons drops to this
  // number AND no SHOW MORE button is available. Acts as a buffer so we
  // don't drain the feed when we can't refill.
  stopAtRemaining?: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runAutomation(deps: AutomationDeps): Promise<void> {
  deps.onEvent({ type: "started" });
  const cooldownMs = Math.max(0, deps.cooldownMs ?? 0);
  const stopAtRemaining = Math.max(0, deps.stopAtRemaining ?? 0);
  let attemptId = 0;
  let idleExpansions = 0;
  let index = 0;

  while (idleExpansions < IDLE_LIMIT) {
    if (stopAtRemaining > 0 && shouldStopForBuffer(stopAtRemaining)) {
      break;
    }

    const button = nextMemoryButton();
    if (button === null) {
      const expanded = await tryShowMore();
      if (expanded) idleExpansions = 0;
      else idleExpansions += 1;
      continue;
    }

    attemptId += 1;
    button.setAttribute(MARKER, String(attemptId));
    deps.onEvent({ type: "clicked", index });
    index += 1;
    button.click();

    const outcome = await deps.nextOutcome();

    if (outcome.ok) {
      deps.onEvent({ type: "approved", txHash: outcome.txHash });
      // Cool-down between approved transactions. Helps when the EvoEvo
      // contract throttles per-user submissions or when the RPC node's
      // mempool needs time to absorb the previous broadcast before the
      // next nonce / gas estimate is accurate.
      if (cooldownMs > 0) await sleep(cooldownMs);
      continue;
    }

    deps.onEvent({ type: "paused", reason: outcome.error.message });
    return;
  }

  deps.onEvent({ type: "done" });
}

function nextMemoryButton(): HTMLElement | null {
  const buttons = Array.from(document.querySelectorAll("button"));
  for (const button of buttons) {
    if (!/add to memory/i.test(button.textContent ?? "")) continue;
    if (button.hasAttribute(MARKER)) continue;
    if (!isVisibleEnabled(button)) continue;
    return button;
  }
  return null;
}

async function tryShowMore(): Promise<boolean> {
  const buttons = Array.from(document.querySelectorAll("button"));
  const showMore = buttons.find((b) => /show more/i.test(b.textContent ?? ""));
  if (!showMore || !isVisibleEnabled(showMore)) return false;
  const before = countMemoryButtons();
  showMore.click();
  await new Promise((r) => setTimeout(r, 0));
  return countMemoryButtons() > before;
}

function countMemoryButtons(): number {
  return Array.from(document.querySelectorAll("button")).filter((b) =>
    /add to memory/i.test(b.textContent ?? ""),
  ).length;
}

function isVisibleEnabled(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  // happy-dom does not implement layout, so treat as visible if attached
  return el.isConnected;
}

function shouldStopForBuffer(threshold: number): boolean {
  const unmarked = Array.from(document.querySelectorAll("button")).filter(
    (button) =>
      /add to memory/i.test(button.textContent ?? "") &&
      !button.hasAttribute(MARKER) &&
      isVisibleEnabled(button),
  ).length;
  const canExpand = Array.from(document.querySelectorAll("button")).some(
    (button) =>
      /show more/i.test(button.textContent ?? "") && isVisibleEnabled(button),
  );
  return unmarked <= threshold && !canExpand;
}
