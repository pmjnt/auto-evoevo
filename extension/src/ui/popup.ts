import { send } from "./shared.js";

type ExtensionConfig = {
  allowedOrigin: string;
  allowedChain: string;
  chainId: number;
  rpcUrl: string;
  allowedContracts: string[];
  allowedFunctionSelectors: string[];
  maxFeeNative: number;
  dryRun: boolean;
  idleLockMinutes: number;
  cooldownSeconds: number;
  overrideWalletProvider: boolean;
  stopAtRemaining: number;
};

type Status = {
  ok: boolean;
  locked: boolean;
  address: string | null;
  paused: boolean;
  automationStatus?: "idle" | "running" | "reloading" | "paused" | "done" | "error";
  counts: Record<string, number>;
  lastError?: string | null;
};

const DEFAULT_CONFIG: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://evmrpc.0g.ai",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  allowedFunctionSelectors: ["0xd0e30db0"],
  maxFeeNative: 0.001,
  dryRun: true,
  idleLockMinutes: 30,
  cooldownSeconds: 3,
  overrideWalletProvider: true,
  stopAtRemaining: 10,
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
let lastConfig: ExtensionConfig = DEFAULT_CONFIG;

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
  setText("runtime-error", status.lastError ?? "");

  const statusText = status.automationStatus ?? (status.paused ? "paused" : "running");
  setText("status-text", statusText);
  const statusEl = document.getElementById("status-text");
  if (statusEl) {
    statusEl.style.color =
      statusText === "running"
        ? "#65d18f"
        : statusText === "error"
          ? "#ff6b6b"
          : "#ffd166";
  }

  const pauseBtn = document.getElementById("pause") as HTMLButtonElement | null;
  if (pauseBtn) pauseBtn.textContent = status.paused ? "Resume" : "Pause";

  await refreshConfig();
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
  await startAutomation();
});

document.getElementById("override-wallet")?.addEventListener("change", async (event) => {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  const nextConfig = { ...lastConfig, overrideWalletProvider: checked };
  const response = await send({ type: "set-config", config: nextConfig });
  if (!response.ok) {
    (event.currentTarget as HTMLInputElement).checked =
      lastConfig.overrideWalletProvider;
    setText("runtime-error", "Failed to save wallet override setting.");
    return;
  }
  lastConfig = nextConfig;
  setText("runtime-error", "");
});

async function startAutomation(): Promise<void> {
  setText("start-msg", "Starting...");
  const response = (await send({ type: "start" })) as {
    ok: boolean;
    error?: { message: string };
    tabsNotified?: number;
  };
  if (!response.ok) {
    setText("start-msg", response.error?.message ?? "Failed to start");
    return;
  }
  const notified = response.tabsNotified ?? 0;
  setText(
    "start-msg",
    notified > 0
      ? `Started on ${notified} EvoEvo tab(s).`
      : "No evoevo.ai tab open - open https://evoevo.ai/feed first.",
  );
  await refresh();
}

async function refreshConfig(): Promise<void> {
  const response = (await send({ type: "get-config" })) as {
    ok: boolean;
    config?: Partial<ExtensionConfig> | null;
  };
  if (!response.ok) return;
  lastConfig = { ...DEFAULT_CONFIG, ...(response.config ?? {}) };
  const toggle = document.getElementById("override-wallet") as HTMLInputElement | null;
  if (toggle) toggle.checked = lastConfig.overrideWalletProvider;
}

void refresh();
setInterval(() => {
  void refresh();
}, 2000);
