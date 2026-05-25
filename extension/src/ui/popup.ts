import { send } from "./shared.js";
import type { ExtensionConfig } from "../shared/types.js";

const DEFAULT_CONFIG: ExtensionConfig = {
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  chainId: 16661,
  rpcUrl: "https://evmrpc.0g.ai",
  allowedContracts: ["0x61bb71442749d13a4bb7257dfbfff0452ae937f9"],
  allowedFunctionSelectors: ["0x4ed1f275"],
  maxFeeNative: 0.01,
  dryRun: true,
  idleLockMinutes: 30,
  cooldownSeconds: 1,
  stopAtRemaining: 10,
  agentId: 0,
};

type Status = {
  ok: boolean;
  locked: boolean;
  address: string | null;
  paused: boolean;
  running?: boolean;
  counts: Record<string, number>;
};

type AgentSummary = {
  id: number;
  name: string;
  onchain_identity: { identity_agent_id?: string } | null;
};

function show(id: "locked" | "unlocked"): void {
  document.getElementById("locked")?.classList.toggle("active", id === "locked");
  document.getElementById("unlocked")?.classList.toggle("active", id === "unlocked");
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
  if (status.locked) {
    show("locked");
    return;
  }
  show("unlocked");
  setText("address", status.address ?? "—");
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
  setInput("allowedContracts", config.allowedContracts.join(", "));
  setInput("allowedFunctionSelectors", config.allowedFunctionSelectors.join(", "));
  setInput("idleLockMinutes", config.idleLockMinutes);
  setInput("cooldownSeconds", config.cooldownSeconds);
  setInput("stopAtRemaining", config.stopAtRemaining);
  setChecked("dryRun", config.dryRun);

  // Seed the agent dropdown with the saved id so it doesn't read 0
  // before the user refreshes the live list.
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

document.getElementById("unlock")?.addEventListener("click", async () => {
  const password = elValue("password");
  const response = (await send({ type: "unlock", password })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!response.ok) {
    setMsg("unlock-error", response.error?.message ?? "Failed to unlock", "err");
    return;
  }
  setMsg("unlock-error", "", "info");
  configLoaded = false;
  await refreshStatus();
});

document.getElementById("lock")?.addEventListener("click", async () => {
  await send({ type: "lock" });
  configLoaded = false;
  await refreshStatus();
});

document.getElementById("pause")?.addEventListener("click", async () => {
  const type = lastStatus?.paused ? "resume" : "pause";
  await send({ type });
  await refreshStatus();
});

document.getElementById("start")?.addEventListener("click", async () => {
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
  const dryRunEl = document.getElementById("dryRun") as HTMLInputElement | null;
  const config = {
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    chainId: Number(elValue("chainId")) || DEFAULT_CONFIG.chainId,
    rpcUrl: elValue("rpcUrl") || DEFAULT_CONFIG.rpcUrl,
    allowedContracts: elValue("allowedContracts")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedFunctionSelectors: elValue("allowedFunctionSelectors")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxFeeNative: Number(elValue("maxFeeNative")) || DEFAULT_CONFIG.maxFeeNative,
    dryRun: dryRunEl?.checked ?? true,
    idleLockMinutes: Number(elValue("idleLockMinutes")) || 30,
    cooldownSeconds: Math.max(0, Math.min(300, Number(elValue("cooldownSeconds")) || 0)),
    stopAtRemaining: Math.max(0, Math.min(1000, Number(elValue("stopAtRemaining")) || 0)),
    agentId: Math.max(0, Number(elValue("agentId")) || 0),
  };

  const setConfigResp = (await send({ type: "set-config", config })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!setConfigResp.ok) {
    setMsg("save-msg", `Failed to save: ${setConfigResp.error?.message ?? "unknown"}`, "err");
    return;
  }

  const privateKey = elValue("privateKey");
  const password = elValue("vaultPassword");
  if (privateKey && password) {
    const importResp = (await send({ type: "import-key", privateKey, password })) as {
      ok: boolean;
      error?: { message: string };
    };
    if (!importResp.ok) {
      setMsg(
        "save-msg",
        `Config saved but key import failed: ${importResp.error?.message ?? "unknown"}`,
        "err",
      );
      return;
    }
    setInput("privateKey", "");
    setInput("vaultPassword", "");
  }

  setMsg("save-msg", "Saved.", "ok");
});

void refreshStatus();

setInterval(() => {
  void refreshStatus();
}, 2000);
