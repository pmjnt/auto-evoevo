import { send } from "./shared.js";

type Status = {
  ok: boolean;
  locked: boolean;
  address: string | null;
  paused: boolean;
  counts: Record<string, number>;
  automationTab?: {
    state: "none" | "ready" | "closed";
    id: number | null;
  };
};

function show(id: "locked" | "unlocked"): void {
  document.getElementById("locked")?.classList.toggle("active", id === "locked");
  document.getElementById("unlocked")?.classList.toggle("active", id === "unlocked");
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

let lastStatus: Status | null = null;

async function refresh(): Promise<void> {
  const status = (await send({ type: "get-status" })) as Status;
  if (!status.ok) return;
  lastStatus = status;

  if (status.locked) {
    show("locked");
    return;
  }
  show("unlocked");
  setText("address", status.address ?? "-");
  setText("signed", String(status.counts["signed"] ?? 0));
  setText("dry", String(status.counts["dry_run"] ?? 0));
  setText("manual", String(status.counts["manual_review"] ?? 0));
  setText("rejected", String(status.counts["rejected"] ?? 0));
  setText("automation-tab", automationTabLabel(status.automationTab));

  const statusText = status.paused ? "paused" : "running";
  setText("status-text", statusText);
  const statusEl = document.getElementById("status-text");
  if (statusEl) {
    statusEl.style.color = status.paused ? "#ffd166" : "#65d18f";
  }

  const pauseBtn = document.getElementById("pause") as HTMLButtonElement | null;
  if (pauseBtn) pauseBtn.textContent = status.paused ? "Resume" : "Pause";
}

document.getElementById("unlock")?.addEventListener("click", async () => {
  const password = (document.getElementById("password") as HTMLInputElement).value;
  const response = (await send({ type: "unlock", password })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!response.ok) {
    setText("unlock-error", response.error?.message ?? "Failed to unlock");
    return;
  }
  await refresh();
});

document.getElementById("lock")?.addEventListener("click", async () => {
  await send({ type: "lock" });
  await refresh();
});

document.getElementById("pause")?.addEventListener("click", async () => {
  const type = lastStatus?.paused ? "resume" : "pause";
  await send({ type });
  await refresh();
});

document.getElementById("start")?.addEventListener("click", async () => {
  await startAutomation("start");
});

document.getElementById("start-dedicated")?.addEventListener("click", async () => {
  await startAutomation("start-dedicated");
});

async function startAutomation(type: "start" | "start-dedicated"): Promise<void> {
  setText("start-msg", "Starting...");
  const response = (await send({ type })) as {
    ok: boolean;
    error?: { message: string };
    tabsNotified?: number;
    tabId?: number;
    created?: boolean;
  };
  if (!response.ok) {
    setText("start-msg", response.error?.message ?? "Failed to start");
    return;
  }
  const notified = response.tabsNotified ?? 0;
  if (type === "start-dedicated") {
    const action = response.created ? "Created and started" : "Started";
    setText(
      "start-msg",
      notified > 0
        ? `${action} dedicated tab #${response.tabId ?? "-"}.`
        : "Dedicated tab is open, but the content script did not respond yet. Refresh the tab and try again.",
    );
  } else {
    setText(
      "start-msg",
      notified > 0
        ? `Started on ${notified} EvoEvo tab(s).`
        : "No evoevo.ai tab open - open https://evoevo.ai/feed first.",
    );
  }
  await refresh();
}

function automationTabLabel(tab: Status["automationTab"]): string {
  if (!tab || tab.state === "none") return "none";
  if (tab.state === "closed") return `closed #${tab.id}`;
  return `ready #${tab.id}`;
}

void refresh();
setInterval(() => {
  void refresh();
}, 2000);
