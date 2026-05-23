const MARKER = "data-auto-evoevo-attempted-id";
const IDLE_LIMIT = 2;
const DEFAULT_OUTCOME_TIMEOUT_MS = 10_000;
const DEFAULT_MODAL_CLOSE_TIMEOUT_MS = 90_000;
const MODAL_POLL_MS = 250;

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
  nextOutcome: (signal: AbortSignal) => Promise<Outcome>;
  onEvent: (event: AutomationEvent) => void;
  cooldownMs?: number;
  outcomeTimeoutMs?: number;
  modalCloseTimeoutMs?: number;
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
  const outcomeTimeoutMs = Math.max(
    1,
    deps.outcomeTimeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS,
  );
  const modalCloseTimeoutMs = Math.max(
    1,
    deps.modalCloseTimeoutMs ?? DEFAULT_MODAL_CLOSE_TIMEOUT_MS,
  );
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

    const outcome = await waitForOutcome(deps.nextOutcome, outcomeTimeoutMs);

    if (outcome.ok) {
      deps.onEvent({ type: "approved", txHash: outcome.txHash });
      const modalClosed = await waitForSubmittingModalToClose(modalCloseTimeoutMs);
      if (!modalClosed) {
        deps.onEvent({
          type: "paused",
          reason: "Timed out waiting for EvoEvo submission modal to close",
        });
        return;
      }
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

async function waitForOutcome(
  nextOutcome: AutomationDeps["nextOutcome"],
  timeoutMs: number,
): Promise<Outcome> {
  const controller = new AbortController();
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: {
          code: 408,
          message: "Timed out waiting for transaction after click",
        },
      });
    }, timeoutMs);

    nextOutcome(controller.signal)
      .then((outcome) => {
        clearTimeout(timeout);
        resolve(outcome);
      })
      .catch((error) => {
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: {
            code: 4001,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  });
}

async function waitForSubmittingModalToClose(timeoutMs: number): Promise<boolean> {
  if (!hasSubmittingModal()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(MODAL_POLL_MS);
    if (!hasSubmittingModal()) return true;
  }
  return !hasSubmittingModal();
}

function hasSubmittingModal(): boolean {
  const text = document.body.textContent ?? "";
  return /submitting on-chain/i.test(text) || /loading your agents/i.test(text);
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
