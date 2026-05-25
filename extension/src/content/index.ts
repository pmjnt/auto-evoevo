import { runAutomation, type Outcome } from "./automation.js";

const SOURCE_PAGE = "auto-evoevo-page";
const SOURCE_EXT = "auto-evoevo-ext";

// A 1-second silent WAV. Played in a loop while automation runs so the
// tab is considered "audible" by Chrome, which disables background
// timer throttling. Without this, switching to another tab while the
// loop is running slows setTimeout to ~1s, breaking the receipt wait
// and cooldown timing.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let keepAliveAudio: HTMLAudioElement | null = null;

function keepTabActive(): void {
  if (keepAliveAudio !== null) return;
  try {
    const audio = new Audio(SILENT_WAV);
    audio.loop = true;
    audio.volume = 0.001; // basically inaudible but not muted (muted may still be throttled)
    void audio.play().catch(() => {
      // Browser may block autoplay without a user gesture on the page
      // itself; the request came from the popup so the page does not
      // have a user activation. Automation still works but the tab
      // will be throttled when backgrounded — the user can click
      // anywhere on the page once to grant a gesture, then re-Start.
    });
    keepAliveAudio = audio;
  } catch {
    keepAliveAudio = null;
  }
}

function stopKeepingTabActive(): void {
  if (keepAliveAudio === null) return;
  try {
    keepAliveAudio.pause();
    keepAliveAudio.src = "";
  } catch {
    // ignore
  }
  keepAliveAudio = null;
}

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
    keepTabActive(); // prevent Chrome from throttling the tab when it is hidden
    void runAutomation({
      nextOutcome,
      cooldownMs,
      stopAtRemaining,
      onEvent: (event) => chrome.runtime.sendMessage({ type: "automation-event", event }),
    }).finally(() => {
      automationRunning = false;
      stopKeepingTabActive();
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
