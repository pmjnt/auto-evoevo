import { parseMessage } from "../shared/messages.js";
import { getConfig, setConfig as persistConfig } from "./storage.js";
import { Wallet } from "./wallet.js";
import { RpcClient } from "./rpc.js";
import { SessionLog } from "./session-log.js";
import { runPipeline } from "./pipeline.js";

const wallet = new Wallet();
const log = new SessionLog();
let paused = false;
let reloadResumeTabId: number | null = null;
let lastError: string | null = null;
let tabLifecycleListenerInstalled = false;
let tabLifecycleSource: typeof chrome.tabs | null = null;

const READ_ONLY_METHODS = new Set([
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getLogs",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_uninstallFilter",
  "eth_syncing",
  "web3_clientVersion",
]);

export type RouterResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: { code: number; message: string } };

export async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<RouterResponse> {
  installTabLifecycleListener();

  let message;
  try {
    message = parseMessage(raw);
  } catch {
    return { ok: false, error: { code: -32600, message: "Invalid message" } };
  }

  switch (message.type) {
    case "unlock": {
      const result = await wallet.unlock(message.password);
      if (!result.ok) {
        return { ok: false, error: { code: 4100, message: result.reason } };
      }
      await broadcastWalletEventToEvoEvoTabs("accountsChanged", [
        wallet.address as string,
      ]);
      return { ok: true, address: wallet.address };
    }

    case "lock": {
      wallet.lock();
      await broadcastWalletEventToEvoEvoTabs("accountsChanged", []);
      return { ok: true };
    }

    case "get-status": {
      return {
        ok: true,
        locked: wallet.address === null,
        address: wallet.address,
        paused,
        counts: await log.counts(),
        lastError,
      };
    }

    case "get-config":
      return { ok: true, config: await getConfig() };

    case "pause":
      paused = true;
      lastError = null;
      return { ok: true };

    case "resume": {
      paused = false;
      lastError = null;
      const settings = await currentAutomationSettings();
      const tabsNotified = await broadcastStartToEvoEvoTabs(settings);
      return { ok: true, tabsNotified };
    }

    case "start": {
      paused = false;
      lastError = null;
      const settings = await currentAutomationSettings();
      const tabsNotified = await broadcastStartToEvoEvoTabs(settings);
      return { ok: true, tabsNotified };
    }

    case "stop":
      paused = true;
      lastError = null;
      return { ok: true };

    case "automation-event":
      if (message.event.type === "started") {
        paused = false;
        lastError = null;
      }
      if (message.event.type === "paused") {
        paused = true;
        lastError = message.event.reason ?? "Automation paused";
      }
      if (message.event.type === "done") {
        paused = true;
        lastError = null;
      }
      if (message.event.type === "reload_requested") return await reloadSenderTab(sender);
      return { ok: true };

    case "set-config":
      await persistConfig(message.config);
      return { ok: true };

    case "import-key": {
      const { encryptVault } = await import("../shared/crypto.js");
      const { setVault } = await import("./storage.js");
      const vault = await encryptVault(message.privateKey, message.password);
      await setVault(vault);
      return { ok: true };
    }

    case "rpc-request": {
      const origin = senderOrigin(sender);
      if (origin === null) {
        return { ok: false, error: { code: 4001, message: "Origin missing" } };
      }

      const config = await getConfig();
      if (config === null) {
        return { ok: false, error: { code: 4100, message: "Extension not configured" } };
      }

      // Wallet/chain identity methods — answer locally without RPC.
      if (
        message.method === "eth_requestAccounts" ||
        message.method === "eth_accounts"
      ) {
        return { ok: true, result: wallet.address === null ? [] : [wallet.address] };
      }

      if (message.method === "eth_chainId") {
        return { ok: true, result: "0x" + config.chainId.toString(16) };
      }

      if (message.method === "net_version") {
        return { ok: true, result: String(config.chainId) };
      }

      if (message.method === "wallet_switchEthereumChain") {
        const param = (message.params[0] ?? {}) as { chainId?: unknown };
        const requested =
          typeof param.chainId === "string"
            ? Number.parseInt(param.chainId, 16)
            : null;
        if (requested !== config.chainId) {
          return {
            ok: false,
            error: { code: 4902, message: `Unsupported chain: ${param.chainId}` },
          };
        }
        return { ok: true, result: null };
      }

      if (message.method === "wallet_addEthereumChain") {
        // Treat as no-op if it matches our configured chain; otherwise reject.
        const param = (message.params[0] ?? {}) as { chainId?: unknown };
        const requested =
          typeof param.chainId === "string"
            ? Number.parseInt(param.chainId, 16)
            : null;
        if (requested !== config.chainId) {
          return {
            ok: false,
            error: { code: 4902, message: `Cannot add chain: ${param.chainId}` },
          };
        }
        return { ok: true, result: null };
      }

      if (message.method === "eth_sendTransaction") {
        if (paused) {
          return { ok: false, error: { code: 4001, message: "Automation paused" } };
        }
        const rpc = new RpcClient(config.rpcUrl);
        const result = await runPipeline({
          method: message.method,
          params: message.params,
          senderOrigin: origin,
          config,
          wallet,
          rpc,
          log,
        });
        if (result.ok) {
          return { ok: true, result: result.txHash };
        }
        return { ok: false, error: { code: result.errorCode, message: result.reason } };
      }

      // Forward read-only methods to the configured RPC. Reject any write
      // method we have not explicitly approved above.
      if (READ_ONLY_METHODS.has(message.method)) {
        try {
          const rpc = new RpcClient(config.rpcUrl);
          const result = await rpc.call<unknown>(message.method, message.params);
          return { ok: true, result };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, error: { code: -32603, message: reason } };
        }
      }

      return {
        ok: false,
        error: { code: 4200, message: `Unsupported method: ${message.method}` },
      };
    }

    default:
      return { ok: false, error: { code: -32601, message: `Unhandled type: ${(message as { type: string }).type}` } };
  }
}

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  const url = sender.tab?.url;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type AutomationSettings = { cooldownMs: number; stopAtRemaining: number };
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function broadcastStartToEvoEvoTabs(
  settings: AutomationSettings,
): Promise<number> {
  return await broadcastToEvoEvoTabs({
    type: "start-automation",
    cooldownMs: settings.cooldownMs,
    stopAtRemaining: settings.stopAtRemaining,
  });
}

async function sendStartToTab(
  tabId: number,
  settings: AutomationSettings,
): Promise<number> {
  if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) return 0;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "start-automation",
      cooldownMs: settings.cooldownMs,
      stopAtRemaining: settings.stopAtRemaining,
    });
    return 1;
  } catch {
    return 0;
  }
}

async function currentAutomationSettings(): Promise<AutomationSettings> {
  const config = await getConfig();
  return {
    cooldownMs: Math.max(0, (config?.cooldownSeconds ?? 0) * 1000),
    stopAtRemaining: Math.max(0, config?.stopAtRemaining ?? 0),
  };
}

async function broadcastWalletEventToEvoEvoTabs(
  event: string,
  value: unknown,
): Promise<void> {
  await broadcastToEvoEvoTabs({ type: "wallet-event", event, value });
}

async function broadcastToEvoEvoTabs(message: unknown): Promise<number> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return 0;
  const tabs = await chrome.tabs.query({ url: "https://evoevo.ai/*" });
  let notified = 0;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      notified += 1;
    } catch {
      // tab without content script attached — ignore
    }
  }
  return notified;
}

async function reloadSenderTab(
  sender: chrome.runtime.MessageSender,
): Promise<RouterResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    paused = true;
    lastError = "Cannot reload EvoEvo tab: sender tab missing.";
    return { ok: false, error: { code: 4001, message: lastError } };
  }

  if (typeof chrome === "undefined" || !chrome.tabs?.reload) {
    paused = true;
    lastError = "Cannot reload EvoEvo tab: chrome.tabs.reload unavailable.";
    return { ok: false, error: { code: 4001, message: lastError } };
  }

  reloadResumeTabId = tabId;
  paused = false;
  lastError = "Reloading EvoEvo after submitted transaction...";
  await chrome.tabs.reload(tabId);
  return { ok: true, reloading: true, tabId };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true;
  });
}

function installTabLifecycleListener(): void {
  if (typeof chrome === "undefined" || !chrome.tabs?.onUpdated) return;
  if (tabLifecycleListenerInstalled && tabLifecycleSource === chrome.tabs) return;
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== reloadResumeTabId || changeInfo.status !== "complete") return;
    reloadResumeTabId = null;
    void resumeAutomationInTab(tabId);
  });
  tabLifecycleListenerInstalled = true;
  tabLifecycleSource = chrome.tabs;
}

async function resumeAutomationInTab(tabId: number): Promise<void> {
  paused = false;
  lastError = null;
  const settings = await currentAutomationSettings();
  let notified = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    notified = await sendStartToTab(tabId, settings);
    if (notified > 0) break;
    await sleep(500);
  }
  if (notified === 0) {
    paused = true;
    lastError =
      "Reloaded EvoEvo tab but the content script did not respond. Press Start again.";
  }
}

installTabLifecycleListener();

// Make the action icon open the side panel instead of a popup. The
// panel persists across tab switches, so the user can watch automation
// status while doing other things in another tab.
if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      // Older Chromes may not support the API; ignore.
    });
}
