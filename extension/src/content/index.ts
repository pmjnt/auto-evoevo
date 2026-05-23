import { runAutomation, type Outcome } from "./automation.js";

const SOURCE_PAGE = "auto-evoevo-page";
const SOURCE_EXT = "auto-evoevo-ext";

const outcomeQueue: Outcome[] = [];
const outcomeWaiters: Array<(value: Outcome) => void> = [];

function pushOutcome(outcome: Outcome): void {
  const waiter = outcomeWaiters.shift();
  if (waiter) waiter(outcome);
  else outcomeQueue.push(outcome);
}

function nextOutcome(signal: AbortSignal): Promise<Outcome> {
  const buffered = outcomeQueue.shift();
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve) => {
    const waiter = (value: Outcome): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      const index = outcomeWaiters.indexOf(waiter);
      if (index >= 0) outcomeWaiters.splice(index, 1);
    };
    if (signal.aborted) return;
    signal.addEventListener("abort", onAbort, { once: true });
    outcomeWaiters.push(waiter);
  });
}

// inpage.js is injected by manifest content_scripts with world:"MAIN"
// (see manifest.json), so we don't need to inject a <script src> here.
// That older approach was blocked by evoevo.ai's CSP.

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (data?.source !== SOURCE_PAGE || data?.target !== "ext") return;
  if (data?.type !== "rpc-request") return;

  chrome.runtime.sendMessage(data, (response: unknown) => {
    const resp = (response as Record<string, unknown>) ?? {};
    window.postMessage(
      { source: SOURCE_EXT, target: "page", type: "rpc-response", id: data.id, ...resp },
      "*",
    );

    if (data.method === "eth_sendTransaction") {
      if (resp.ok === true) {
        pushOutcome({ ok: true, txHash: String(resp.result ?? "") });
      } else {
        const err = (resp.error as { code?: number; message?: string } | undefined) ?? {};
        pushOutcome({
          ok: false,
          error: { code: err.code ?? 4001, message: err.message ?? "rejected" },
        });
      }
    }
  });
});

let automationRunning = false;

chrome.runtime.onMessage.addListener((message: unknown) => {
  const value = message as {
    type?: string;
    event?: string;
    value?: unknown;
    cooldownMs?: number;
    stopAtRemaining?: number;
  };
  if (value?.type === "start-automation") {
    if (automationRunning) return;
    automationRunning = true;
    const cooldownMs =
      typeof value.cooldownMs === "number" && value.cooldownMs >= 0
        ? value.cooldownMs
        : 0;
    const stopAtRemaining =
      typeof value.stopAtRemaining === "number" && value.stopAtRemaining >= 0
        ? value.stopAtRemaining
        : 0;
    void runAutomation({
      nextOutcome,
      cooldownMs,
      stopAtRemaining,
      onEvent: (event) => chrome.runtime.sendMessage({ type: "automation-event", event }),
    }).finally(() => {
      automationRunning = false;
    });
    return;
  }
  if (value?.type === "wallet-event") {
    window.postMessage(
      {
        source: SOURCE_EXT,
        target: "page",
        type: "event",
        event: value.event,
        value: value.value,
      },
      "*",
    );
  }
});
