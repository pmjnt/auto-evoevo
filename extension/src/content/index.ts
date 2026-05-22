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

function nextOutcome(): Promise<Outcome> {
  const buffered = outcomeQueue.shift();
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve) => outcomeWaiters.push(resolve));
}

function injectInpage(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inpage.js");
  script.async = false;
  (document.head ?? document.documentElement).appendChild(script);
  script.remove();
}

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
        pushOutcome({ ok: true, txHash: String(resp.txHash ?? "") });
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

chrome.runtime.onMessage.addListener((message: unknown) => {
  const value = message as { type?: string };
  if (value?.type === "start-automation") {
    void runAutomation({
      nextOutcome,
      onEvent: (event) => chrome.runtime.sendMessage({ type: "automation-event", event }),
    });
  }
});

injectInpage();
