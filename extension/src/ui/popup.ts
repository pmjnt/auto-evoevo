import { send } from "./shared.js";
import type { ExtensionConfig } from "../shared/types.js";

const DEFAULT_CONFIG: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://evmrpc.0g.ai",
  allowedContracts: ["0x61bb71442749d13a4bb7257dfbfff0452ae937f9"],
  allowedFunctionSelectors: ["0xa29adb25"],
  maxFeeNative: 0.01,
  gasPriceJitterPercent: 10,
  dryRun: true,
  cooldownSeconds: 1,
  stopAtRemaining: 10,
  agentId: 0,
  repeatIntervalMinutes: 120,
  reconciliationIntervalMinutes: 1440,
};

type Status = {
  ok: boolean;
  ready: boolean;
  address: string | null;
  paused: boolean;
  running?: boolean;
  lastRunStatus?: "idle" | "running" | "done" | "error";
  counts: Record<string, number>;
};

type AgentSummary = {
  id: number;
  name: string;
  onchain_identity: { identity_agent_id?: string } | null;
};

function show(id: "setup" | "ready"): void {
  document.getElementById("setup")?.classList.toggle("active", id === "setup");
  document.getElementById("ready")?.classList.toggle("active", id === "ready");
}

function elValue(id: string, fallback = ""): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return el?.value.trim() ?? fallback;
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setInput(id: string, value: string | number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = String(value);
}

function setChecked(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

function setMsg(id: string, text: string, kind: "ok" | "err" | "info" = "info"): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("ok", kind === "ok");
  el.classList.toggle("err", kind === "err");
}

let lastStatus: Status | null = null;
let configLoaded = false;

async function refreshStatus(): Promise<void> {
  const status = (await send({ type: "get-status" })) as Status;
  if (!status.ok) return;
  lastStatus = status;
  if (!status.ready) {
    show("setup");
    return;
  }
  show("ready");
  setText("address", status.address ?? "—");
  setInput("walletAddress", status.address ?? "");
  setText("signed", String(status.counts["signed"] ?? 0));
  setText("dry", String(status.counts["dry_run"] ?? 0));
  setText("manual", String(status.counts["manual_review"] ?? 0));
  setText("rejected", String(status.counts["rejected"] ?? 0));
  setText("reverted", String(status.counts["reverted"] ?? 0));

  const statusEl = document.getElementById("status-text");
  if (statusEl) {
    if (status.paused) {
      statusEl.textContent = "paused";
      statusEl.style.color = "#ffd166";
    } else if (status.running) {
      statusEl.textContent = "running";
      statusEl.style.color = "#65d18f";
    } else if (status.lastRunStatus === "done") {
      statusEl.textContent = "done";
      statusEl.style.color = "#65d18f";
    } else if (status.lastRunStatus === "error") {
      statusEl.textContent = "error";
      statusEl.style.color = "#ef6461";
    } else {
      statusEl.textContent = "idle";
      statusEl.style.color = "#b9a895";
    }
  }

  const pauseBtn = document.getElementById("pause") as HTMLButtonElement | null;
  if (pauseBtn) pauseBtn.textContent = status.paused ? "Resume" : "Pause";

  if (!configLoaded) {
    await loadConfig();
    configLoaded = true;
  }
}

function fillConfig(config: ExtensionConfig): void {
  setInput("rpcUrl", config.rpcUrl);
  setInput("chainId", config.chainId);
  setInput("maxFeeNative", config.maxFeeNative);
  setInput("gasPriceJitterPercent", config.gasPriceJitterPercent);
  setInput("allowedContracts", config.allowedContracts.join(", "));
  setInput("allowedFunctionSelectors", config.allowedFunctionSelectors.join(", "));
  setInput("cooldownSeconds", config.cooldownSeconds);
  setInput("stopAtRemaining", config.stopAtRemaining);
  setChecked("dryRun", config.dryRun);

  const agentSelect = document.getElementById("agentId") as HTMLSelectElement | null;
  if (agentSelect && config.agentId > 0) {
    agentSelect.innerHTML = `<option value="${config.agentId}">Saved: ${config.agentId} (refresh to verify)</option>`;
    agentSelect.value = String(config.agentId);
  }
}

async function loadConfig(): Promise<void> {
  fillConfig(DEFAULT_CONFIG);
  const response = (await send({ type: "get-config" })) as {
    ok: boolean;
    config?: ExtensionConfig | null;
  };
  if (response.ok && response.config) {
    fillConfig({ ...DEFAULT_CONFIG, ...response.config });
  }
}

async function loadAgents(): Promise<void> {
  const select = document.getElementById("agentId") as HTMLSelectElement | null;
  if (!select) return;
  const savedValue = select.value;
  select.innerHTML = '<option value="0">Loading…</option>';
  const response = (await send({ type: "get-agents" })) as {
    ok: boolean;
    agents?: AgentSummary[];
    error?: { message: string };
  };
  if (!response.ok || !response.agents) {
    select.innerHTML = `<option value="0">Failed: ${response.error?.message ?? "unknown"}</option>`;
    return;
  }
  const agents = response.agents;
  if (agents.length === 0) {
    select.innerHTML = '<option value="0">No agents for this wallet</option>';
    return;
  }
  select.innerHTML = agents
    .map((a) => {
      const onchain = a.onchain_identity?.identity_agent_id;
      const label = `#${a.id} ${a.name}` + (onchain ? ` (token ${onchain})` : "");
      return `<option value="${a.id}">${label}</option>`;
    })
    .join("");
  if (agents.some((a) => String(a.id) === savedValue)) {
    select.value = savedValue;
  }
}

// --- WIRING ---

document.getElementById("saveKey")?.addEventListener("click", async () => {
  const raw = elValue("setupPrivateKey").trim();
  if (!raw) {
    setMsg("setup-msg", "Paste a private key first.", "err");
    return;
  }
  const privateKey = raw.startsWith("0x") ? raw : `0x${raw}`;
  const response = (await send({ type: "set-private-key", privateKey })) as {
    ok: boolean;
    address?: string;
    error?: { message: string };
  };
  if (!response.ok) {
    setMsg("setup-msg", response.error?.message ?? "Failed", "err");
    return;
  }
  setInput("setupPrivateKey", "");
  configLoaded = false;
  await refreshStatus();
});

document.getElementById("clearKey")?.addEventListener("click", async () => {
  if (!window.confirm("Remove the private key from this Chrome install?")) return;
  await send({ type: "clear-private-key" });
  configLoaded = false;
  await refreshStatus();
});

document.getElementById("pause")?.addEventListener("click", async () => {
  const type = lastStatus?.paused ? "resume" : "pause";
  await send({ type });
  await refreshStatus();
});

function currentConfig() {
  const dryRunEl = document.getElementById("dryRun") as HTMLInputElement | null;
  return {
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    chainId: Number(elValue("chainId")) || DEFAULT_CONFIG.chainId,
    rpcUrl: elValue("rpcUrl") || DEFAULT_CONFIG.rpcUrl,
    allowedContracts: elValue("allowedContracts")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    allowedFunctionSelectors: elValue("allowedFunctionSelectors")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    maxFeeNative: Number(elValue("maxFeeNative")) || DEFAULT_CONFIG.maxFeeNative,
    gasPriceJitterPercent: (() => {
      const value = Number(elValue("gasPriceJitterPercent"));
      if (!Number.isFinite(value)) return DEFAULT_CONFIG.gasPriceJitterPercent;
      return Math.max(0, Math.min(100, value));
    })(),
    dryRun: dryRunEl?.checked ?? true,
    cooldownSeconds: Math.max(0, Math.min(300, Number(elValue("cooldownSeconds")) || 0)),
    stopAtRemaining: Math.max(0, Math.min(1000, Number(elValue("stopAtRemaining")) || 0)),
    agentId: Math.max(0, Number(elValue("agentId")) || 0),
    repeatIntervalMinutes: DEFAULT_CONFIG.repeatIntervalMinutes,
    reconciliationIntervalMinutes: DEFAULT_CONFIG.reconciliationIntervalMinutes,
  };
}

document.getElementById("start")?.addEventListener("click", async () => {
  setMsg("start-msg", "Saving config…", "info");
  const saveResp = (await send({ type: "set-config", config: currentConfig() })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!saveResp.ok) {
    setMsg("start-msg", `Config save failed: ${saveResp.error?.message ?? "unknown"}`, "err");
    return;
  }
  setMsg("start-msg", "Starting…", "info");
  const response = (await send({ type: "start" })) as {
    ok: boolean;
    started?: boolean;
    note?: string;
    error?: { message: string };
  };
  if (!response.ok) {
    setMsg("start-msg", response.error?.message ?? "Failed to start", "err");
    return;
  }
  if (response.note) {
    setMsg("start-msg", response.note, "info");
  } else {
    setMsg("start-msg", "Started.", "ok");
  }
  await refreshStatus();
});

document.getElementById("loadAgents")?.addEventListener("click", (event) => {
  event.preventDefault();
  void loadAgents();
});

document.getElementById("save")?.addEventListener("click", async () => {
  const config = currentConfig();
  const resp = (await send({ type: "set-config", config })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!resp.ok) {
    setMsg("save-msg", `Failed to save: ${resp.error?.message ?? "unknown"}`, "err");
    return;
  }
  setMsg("save-msg", "Saved.", "ok");
});

void refreshStatus();
setInterval(() => {
  void refreshStatus();
}, 2000);

const MAX_LOG_LINES = 6;

function appendEventLog(text: string): void {
  const el = document.getElementById("event-log");
  if (!el) return;
  const lines = el.textContent?.split("\n").filter(Boolean) ?? [];
  lines.push(text);
  el.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  el.scrollTop = el.scrollHeight;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type !== "direct-event") return;
    const event = message.event as Record<string, unknown>;
    switch (event.type) {
      case "started":
        appendEventLog("[round] started");
        break;
      case "tab":
        appendEventLog(`[tab] ${event.tab}`);
        break;
      case "fetched":
        appendEventLog(`[feed] ${event.tab}: ${event.count} items`);
        break;
      case "approved":
        appendEventLog(`[tx] ${(event.txHash as string).slice(0, 14)}...`);
        break;
      case "paused":
        appendEventLog(`[pause] ${event.reason}`);
        break;
      case "done":
        appendEventLog("[round] done");
        break;
    }
  });
}
