import { send } from "./shared.js";
import type { ExtensionConfig } from "../shared/types.js";

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
  stopAtRemaining: 10,
  runMode: "dom",
  agentId: 0,
};

function value(id: string, fallback = ""): string {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el?.value.trim() ?? fallback;
}

function setValue(id: string, value: string | number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = String(value);
}

function setChecked(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

function setMsg(text: string, color = "#9ece6a"): void {
  const el = document.getElementById("msg");
  if (el) {
    el.textContent = text;
    el.style.color = color;
  }
}

function fillConfig(config: ExtensionConfig): void {
  setValue("rpcUrl", config.rpcUrl);
  setValue("chainId", config.chainId);
  setValue("maxFeeNative", config.maxFeeNative);
  setValue("allowedContracts", config.allowedContracts.join(", "));
  setValue("allowedFunctionSelectors", config.allowedFunctionSelectors.join(", "));
  setValue("idleLockMinutes", config.idleLockMinutes);
  setValue("cooldownSeconds", config.cooldownSeconds);
  setValue("stopAtRemaining", config.stopAtRemaining);
  setChecked("dryRun", config.dryRun);
  const modeEl = document.getElementById("runMode") as HTMLSelectElement | null;
  if (modeEl) modeEl.value = config.runMode;
  // Seed the dropdown with at least the saved value so it doesn't read
  // 0 before we fetch the live agent list.
  const agentSelect = document.getElementById("agentId") as HTMLSelectElement | null;
  if (agentSelect && config.agentId > 0) {
    agentSelect.innerHTML = `<option value="${config.agentId}">Saved: ${config.agentId} (refresh to verify)</option>`;
    agentSelect.value = String(config.agentId);
  }
}

type AgentSummary = {
  id: number;
  name: string;
  onchain_identity: { identity_agent_id?: string } | null;
};

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
    select.innerHTML = '<option value="0">No agents for this wallet on this chain</option>';
    return;
  }
  select.innerHTML = agents
    .map((a) => {
      const onchain = a.onchain_identity?.identity_agent_id;
      const label = `#${a.id} ${a.name}` + (onchain ? ` (token ${onchain})` : "");
      return `<option value="${a.id}">${label}</option>`;
    })
    .join("");
  // Restore previous selection if present in the new list, else first.
  if (agents.some((a) => String(a.id) === savedValue)) {
    select.value = savedValue;
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

void loadConfig();

document.getElementById("loadAgents")?.addEventListener("click", (event) => {
  event.preventDefault();
  void loadAgents();
});

document.getElementById("save")?.addEventListener("click", async () => {
  const dryRunEl = document.getElementById("dryRun") as HTMLInputElement | null;
  const config = {
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    chainId: Number(value("chainId")),
    rpcUrl: value("rpcUrl"),
    allowedContracts: value("allowedContracts").split(",").map((s) => s.trim()).filter(Boolean),
    allowedFunctionSelectors: value("allowedFunctionSelectors").split(",").map((s) => s.trim()).filter(Boolean),
    maxFeeNative: Number(value("maxFeeNative")),
    dryRun: dryRunEl?.checked ?? true,
    idleLockMinutes: Number(value("idleLockMinutes", "30")) || 30,
    cooldownSeconds: Math.max(0, Math.min(300, Number(value("cooldownSeconds")) || 0)),
    stopAtRemaining: Math.max(0, Math.min(1000, Number(value("stopAtRemaining")) || 0)),
    runMode: ((): "dom" | "direct" => {
      const v = (document.getElementById("runMode") as HTMLSelectElement | null)?.value;
      return v === "direct" ? "direct" : "dom";
    })(),
    agentId: Math.max(0, Number(value("agentId")) || 0),
  };

  const setConfig = await send({ type: "set-config", config });
  if (!setConfig.ok) {
    setMsg("Failed to save config", "#f7768e");
    return;
  }

  const privateKey = value("privateKey");
  const password = value("password");
  if (privateKey && password) {
    const importResult = await send({ type: "import-key", privateKey, password });
    if (!importResult.ok) {
      setMsg("Config saved but key import failed", "#f7768e");
      return;
    }
    (document.getElementById("privateKey") as HTMLInputElement).value = "";
    (document.getElementById("password") as HTMLInputElement).value = "";
  }

  setMsg("Saved");
});
