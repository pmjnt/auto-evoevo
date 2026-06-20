import { send } from "./shared.js";
import { formatWorkflowEvent } from "./workflow-events.js";
import type { ExtensionConfig, WorkflowState } from "../shared/types.js";

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
  workflow?: WorkflowState;
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

function setMsg(id: string, message: string, kind: "ok" | "err" | "info" = "info"): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("ok", kind === "ok");
  el.classList.toggle("err", kind === "err");
}

function clampInt(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function validateIntervals(): string | null {
  for (const [id, label] of [
    ["repeatIntervalMinutes", "Repeat interval"],
    ["reconciliationIntervalMinutes", "Full scan interval"],
  ] as const) {
    const value = Number(elValue(id));
    if (!Number.isInteger(value) || value < 30 || value > 1440) {
      return label + " must be between 30 and 1440 minutes.";
    }
  }
  return null;
}

let configLoaded = false;
let selectedTab: "feed" | "predictions" = "feed";

async function refreshStatus(): Promise<void> {
  const status = (await send({ type: "get-status" })) as Status;
  if (!status.ok) return;
  if (!status.ready) {
    show("setup");
    return;
  }

  show("ready");
  const workflow = status.workflow;
  const counters = workflow?.counters;
  const stateText = workflow?.status ?? (status.paused ? "paused" : status.running ? "running" : "idle");

  setText("address", status.address ?? "-");
  setInput("walletAddress", status.address ?? "");
  setText("status-text", stateText);
  setText("active-workflow", workflow?.activeWorkflow ?? workflow?.mode ?? "none");
  setText("next-run", formatNextRun(workflow?.nextRunAt ?? null));
  setText("signed", String(status.counts["signed"] ?? 0));
  setText("failed", String((status.counts["rpc_failed"] ?? 0) + (status.counts["reverted"] ?? 0)));
  setText("owned-agents", String(counters?.ownedAgents ?? 0));
  setText("feed-completed", String(counters?.feedAgentsCompleted ?? 0));
  setText("source-agents", String(counters?.sourceAgents ?? 0));
  setText("predictions-scanned", String(counters?.predictionsScanned ?? 0));
  setText("predictions-added", String(counters?.added ?? 0));
  setText("predictions-skipped", String(counters?.skipped ?? 0));

  const statusEl = document.getElementById("status-text");
  if (statusEl) {
    statusEl.style.color =
      stateText === "running" ? "#65d18f" :
      stateText === "paused" ? "#f2c94c" :
      stateText === "error" ? "#ef6461" :
      "#c9d0d5";
  }

  setRunDisabled(workflow?.status === "running");
  if (workflow?.lastError) setMsg("start-msg", workflow.lastError, "err");

  if (!configLoaded) {
    await loadConfig();
    configLoaded = true;
  }
}

function formatNextRun(value: number | null): string {
  if (value === null) return "-";
  const diffMs = value - Date.now();
  if (diffMs <= 0) return "due";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return String(minutes) + "m";
  return String(Math.ceil(minutes / 60)) + "h";
}

function setRunDisabled(disabled: boolean): void {
  for (const id of ["runFeed", "runPredictions", "runBoth"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = disabled;
  }
}

function fillConfig(config: ExtensionConfig): void {
  setInput("rpcUrl", config.rpcUrl);
  setInput("chainId", config.chainId);
  setInput("maxFeeNative", config.maxFeeNative);
  setInput("gasPriceJitterPercent", config.gasPriceJitterPercent);
  setInput("repeatIntervalMinutes", config.repeatIntervalMinutes);
  setInput("reconciliationIntervalMinutes", config.reconciliationIntervalMinutes);
  setInput("allowedContracts", config.allowedContracts.join(", "));
  setInput("allowedFunctionSelectors", config.allowedFunctionSelectors.join(", "));
  setInput("cooldownSeconds", config.cooldownSeconds);
  setInput("stopAtRemaining", config.stopAtRemaining);
  setChecked("dryRun", config.dryRun);

  const agentSelect = document.getElementById("agentId") as HTMLSelectElement | null;
  if (agentSelect && config.agentId > 0) {
    agentSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = String(config.agentId);
    option.textContent = "Saved target: " + config.agentId;
    agentSelect.append(option);
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
  select.innerHTML = "";
  select.append(option("0", "Loading..."));

  const response = (await send({ type: "get-agents" })) as {
    ok: boolean;
    agents?: AgentSummary[];
    error?: { message: string };
  };

  select.innerHTML = "";
  if (!response.ok || !response.agents) {
    select.append(option("0", "Failed: " + (response.error?.message ?? "unknown")));
    return;
  }
  if (response.agents.length === 0) {
    select.append(option("0", "No agents for this wallet"));
    return;
  }
  for (const agent of response.agents) {
    const onchain = agent.onchain_identity?.identity_agent_id;
    const label = "#" + agent.id + " " + agent.name + (onchain ? " (token " + onchain + ")" : "");
    select.append(option(String(agent.id), label));
  }
  if (response.agents.some((agent) => String(agent.id) === savedValue)) {
    select.value = savedValue;
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function selectTab(tab: "feed" | "predictions"): void {
  selectedTab = tab;
  document.getElementById("tabFeed")?.classList.toggle("active", tab === "feed");
  document.getElementById("tabPredictions")?.classList.toggle("active", tab === "predictions");
  document.getElementById("feed-panel")?.classList.toggle("active", tab === "feed");
  document.getElementById("predictions-panel")?.classList.toggle("active", tab === "predictions");
  document.getElementById("tabFeed")?.setAttribute("aria-selected", String(tab === "feed"));
  document.getElementById("tabPredictions")?.setAttribute("aria-selected", String(tab === "predictions"));
}

function currentConfig(): ExtensionConfig {
  const dryRunEl = document.getElementById("dryRun") as HTMLInputElement | null;
  return {
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    chainId: Number(elValue("chainId")) || DEFAULT_CONFIG.chainId,
    rpcUrl: elValue("rpcUrl") || DEFAULT_CONFIG.rpcUrl,
    allowedContracts: elValue("allowedContracts")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    allowedFunctionSelectors: elValue("allowedFunctionSelectors")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    maxFeeNative: Number(elValue("maxFeeNative")) || DEFAULT_CONFIG.maxFeeNative,
    gasPriceJitterPercent: clampInt(elValue("gasPriceJitterPercent"), DEFAULT_CONFIG.gasPriceJitterPercent, 0, 100),
    dryRun: dryRunEl?.checked ?? true,
    cooldownSeconds: clampInt(elValue("cooldownSeconds"), 0, 0, 300),
    stopAtRemaining: clampInt(elValue("stopAtRemaining"), 0, 0, 1000),
    agentId: Math.max(0, Number(elValue("agentId")) || 0),
    repeatIntervalMinutes: clampInt(elValue("repeatIntervalMinutes"), DEFAULT_CONFIG.repeatIntervalMinutes, 30, 1440),
    reconciliationIntervalMinutes: clampInt(elValue("reconciliationIntervalMinutes"), DEFAULT_CONFIG.reconciliationIntervalMinutes, 30, 1440),
  };
}

async function saveConfig(messageId: string): Promise<boolean> {
  const validationError = validateIntervals();
  if (validationError !== null) {
    setMsg(messageId, validationError, "err");
    return false;
  }
  const config = currentConfig();
  const response = (await send({ type: "set-config", config })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!response.ok) {
    setMsg(messageId, "Config save failed: " + (response.error?.message ?? "unknown"), "err");
    return false;
  }
  return true;
}

async function saveThenRun(type: "run-feed" | "run-predictions" | "run-both"): Promise<void> {
  if (type !== "run-feed" && Number(elValue("agentId")) <= 0) {
    setMsg("start-msg", "Select a target agent before running Predictions.", "err");
    selectTab("predictions");
    return;
  }
  setMsg("start-msg", "Saving config...", "info");
  if (!(await saveConfig("start-msg"))) return;
  const response = (await send({ type })) as {
    ok: boolean;
    started?: boolean;
    error?: { message: string };
  };
  if (!response.ok) {
    setMsg("start-msg", response.error?.message ?? "Failed to run", "err");
    return;
  }
  setMsg("start-msg", "Running.", "ok");
  await refreshStatus();
}

document.getElementById("saveKey")?.addEventListener("click", async () => {
  const raw = elValue("setupPrivateKey").trim();
  if (!raw) {
    setMsg("setup-msg", "Paste a private key first.", "err");
    return;
  }
  const privateKey = raw.startsWith("0x") ? raw : "0x" + raw;
  const response = (await send({ type: "set-private-key", privateKey })) as {
    ok: boolean;
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
  if (!window.confirm("Remove the private key from this Chrome profile?")) return;
  await send({ type: "clear-private-key" });
  configLoaded = false;
  await refreshStatus();
});

document.getElementById("pause")?.addEventListener("click", async () => {
  await send({ type: "pause" });
  setMsg("start-msg", "Paused.", "info");
  await refreshStatus();
});

document.getElementById("runFeed")?.addEventListener("click", () => void saveThenRun("run-feed"));
document.getElementById("runPredictions")?.addEventListener("click", () => void saveThenRun("run-predictions"));
document.getElementById("runBoth")?.addEventListener("click", () => void saveThenRun("run-both"));
document.getElementById("tabFeed")?.addEventListener("click", () => selectTab("feed"));
document.getElementById("tabPredictions")?.addEventListener("click", () => selectTab("predictions"));

document.getElementById("loadAgents")?.addEventListener("click", (event) => {
  event.preventDefault();
  void loadAgents();
});

document.getElementById("save")?.addEventListener("click", async () => {
  if (await saveConfig("save-msg")) setMsg("save-msg", "Saved.", "ok");
});

const MAX_LOG_LINES = 6;
function appendEventLog(message: string): void {
  const el = document.getElementById("event-log");
  if (!el) return;
  const lines = el.textContent?.split("\n").filter(Boolean) ?? [];
  lines.push(message);
  el.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  el.scrollTop = el.scrollHeight;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type !== "workflow-event" && message.type !== "direct-event") return;
    const event = message.event as Record<string, unknown>;
    const formatted = formatWorkflowEvent(event);
    if (formatted !== null) {
      appendEventLog(formatted);
      void refreshStatus();
      return;
    }
    switch (event.type) {
      case "started":
        appendEventLog("[round] started");
        break;
      case "tab":
        appendEventLog("[feed] " + String(event.tab));
        break;
      case "fetched":
        appendEventLog("[feed] " + String(event.tab) + ": " + String(event.count));
        break;
      case "approved":
        appendEventLog("[tx] " + String(event.txHash).slice(0, 14) + "...");
        break;
      case "paused":
        appendEventLog("[pause] " + String(event.reason));
        break;
      case "done":
        appendEventLog("[round] done");
        break;
    }
    void refreshStatus();
  });
}

selectTab(selectedTab);
void refreshStatus();
setInterval(() => void refreshStatus(), 2000);
