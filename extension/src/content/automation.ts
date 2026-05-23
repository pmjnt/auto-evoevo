const MARKER = "data-auto-evoevo-attempted-id";
const IDLE_LIMIT = 2;
const DEFAULT_OUTCOME_TIMEOUT_MS = 10_000;
const DEFAULT_EMPTY_FEED_TIMEOUT_MS = 30_000;
const DEFAULT_MODAL_REFRESH_DELAY_MS = 2_000;
const DOM_POLL_MS = 250;
const CONTROL_SELECTOR =
  "button,[role='button'],a,input[type='button'],input[type='submit'],[tabindex]";

export type AutomationEvent =
  | { type: "started" }
  | { type: "clicked"; index: number }
  | { type: "approved"; txHash: string }
  | { type: "reload_requested" }
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
  emptyFeedTimeoutMs?: number;
  modalRefreshDelayMs?: number;
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
  const emptyFeedTimeoutMs = Math.max(
    1,
    deps.emptyFeedTimeoutMs ?? DEFAULT_EMPTY_FEED_TIMEOUT_MS,
  );
  const modalRefreshDelayMs = Math.max(
    0,
    deps.modalRefreshDelayMs ?? DEFAULT_MODAL_REFRESH_DELAY_MS,
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
      else if (!hasFeedControls() && (await waitForFeedControls(emptyFeedTimeoutMs))) {
        idleExpansions = 0;
      } else {
        idleExpansions += 1;
      }
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
      if (hasSubmittingModal()) {
        if (modalRefreshDelayMs > 0) await sleep(modalRefreshDelayMs);
        deps.onEvent({ type: "reload_requested" });
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

async function waitForFeedControls(timeoutMs: number): Promise<boolean> {
  if (hasFeedControls()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(DOM_POLL_MS);
    if (hasFeedControls()) return true;
  }
  return hasFeedControls();
}

function hasFeedControls(): boolean {
  return controlElements().some((control) =>
    isMemoryControl(control) || isShowMoreControl(control),
  );
}

function hasSubmittingModal(): boolean {
  const elements = Array.from(document.body.querySelectorAll("*"));
  return elements.some((element) => {
    const text = element.textContent ?? "";
    if (!/submitting on-chain|loading your agents/i.test(text)) return false;
    return isVisibleElement(element);
  });
}

function isVisibleElement(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current instanceof HTMLElement) {
      const style = window.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        current.hidden ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
    }
    current = current.parentElement;
  }
  return element.isConnected;
}

function nextMemoryButton(): HTMLElement | null {
  for (const control of controlElements()) {
    if (!isMemoryControl(control)) continue;
    if (control.hasAttribute(MARKER)) continue;
    if (!isVisibleEnabled(control)) continue;
    return control;
  }
  return null;
}

async function tryShowMore(): Promise<boolean> {
  const showMore = controlElements().find((control) =>
    isShowMoreControl(control),
  );
  if (!showMore || !isVisibleEnabled(showMore)) return false;
  const before = countMemoryControls();
  showMore.click();
  await new Promise((r) => setTimeout(r, 0));
  return countMemoryControls() > before;
}

function countMemoryControls(): number {
  return controlElements().filter((control) =>
    isMemoryControl(control),
  ).length;
}

function isVisibleEnabled(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  // happy-dom does not implement layout, so treat as visible if attached
  return el.isConnected;
}

function shouldStopForBuffer(threshold: number): boolean {
  const unmarked = controlElements().filter(
    (control) =>
      isMemoryControl(control) &&
      !control.hasAttribute(MARKER) &&
      isVisibleEnabled(control),
  ).length;
  const canExpand = controlElements().some(
    (control) =>
      isShowMoreControl(control) && isVisibleEnabled(control),
  );
  return unmarked <= threshold && !canExpand;
}

function controlElements(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const controls: HTMLElement[] = [];
  for (const element of Array.from(document.querySelectorAll(CONTROL_SELECTOR))) {
    if (!(element instanceof HTMLElement)) continue;
    if (seen.has(element)) continue;
    seen.add(element);
    controls.push(element);
  }
  return controls;
}

function controlText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isMemoryControl(element: HTMLElement): boolean {
  return controlText(element).toLowerCase() === "add to memory";
}

function isShowMoreControl(element: HTMLElement): boolean {
  return controlText(element).toLowerCase() === "show more";
}
