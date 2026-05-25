import { parseMessage } from "../shared/messages.js";
import { getConfig, setConfig as persistConfig } from "./storage.js";
import { Wallet } from "./wallet.js";
import { RpcClient } from "./rpc.js";
import { SessionLog } from "./session-log.js";
import { runPipeline } from "./pipeline.js";
import { EvoEvoApiClient } from "./evoevo-api.js";
import type { SiweAuth } from "./siwe.js";
import { runDirect } from "./direct-runner.js";

const wallet = new Wallet();
const log = new SessionLog();
let paused = false;

// Persist the SIWE token across service-worker restarts. Lives in
// chrome.storage.session so it is cleared when the user closes Chrome
// entirely but survives the worker idling out.
const SESSION_AUTH_KEY = "evoevo-auth";
const evoEvoApi = new EvoEvoApiClient({
  tokenStorage: {
    load: async (): Promise<SiweAuth | null> => {
      if (typeof chrome === "undefined" || !chrome.storage?.session?.get) return null;
      const stored = (await chrome.storage.session.get(SESSION_AUTH_KEY)) as Record<string, SiweAuth | undefined>;
      return stored[SESSION_AUTH_KEY] ?? null;
    },
    save: async (auth) => {
      if (typeof chrome === "undefined" || !chrome.storage?.session?.set) return;
      await chrome.storage.session.set({ [SESSION_AUTH_KEY]: auth });
    },
    clear: async () => {
      if (typeof chrome === "undefined" || !chrome.storage?.session?.remove) return;
      await chrome.storage.session.remove(SESSION_AUTH_KEY);
    },
  },
});
let directLoopRunning = false;

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
      await evoEvoApi.clearAuth();
      await broadcastWalletEventToEvoEvoTabs("accountsChanged", []);
      return { ok: true };
    }

    case "get-agents": {
      if (wallet.address === null) {
        return { ok: false, error: { code: 4100, message: "Wallet locked" } };
      }
      const config = await getConfig();
      if (config === null) {
        return {
          ok: false,
          error: { code: 4100, message: "Extension not configured" },
        };
      }
      try {
        await evoEvoApi.ensureAuth(wallet.address, (msg) =>
          wallet.signMessage(msg),
        );
        const agents = await evoEvoApi.listAgents(
          wallet.address,
          config.chainId,
        );
        return { ok: true, agents };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    case "get-status": {
      return {
        ok: true,
        locked: wallet.address === null,
        address: wallet.address,
        paused,
        counts: await log.counts(),
      };
    }

    case "get-config":
      return { ok: true, config: await getConfig() };

    case "pause":
      paused = true;
      return { ok: true };

    case "resume": {
      paused = false;
      return await startAutomation();
    }

    case "start": {
      paused = false;
      return await startAutomation();
    }

    case "stop":
      paused = true;
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

async function broadcastStartToEvoEvoTabs(
  settings: AutomationSettings,
): Promise<number> {
  return await broadcastToEvoEvoTabs({
    type: "start-automation",
    cooldownMs: settings.cooldownMs,
    stopAtRemaining: settings.stopAtRemaining,
  });
}

async function currentAutomationSettings(): Promise<AutomationSettings> {
  const config = await getConfig();
  return {
    cooldownMs: Math.max(0, (config?.cooldownSeconds ?? 0) * 1000),
    stopAtRemaining: Math.max(0, config?.stopAtRemaining ?? 0),
  };
}

async function startAutomation(): Promise<RouterResponse> {
  const config = await getConfig();
  if (config === null) {
    return {
      ok: false,
      error: { code: 4100, message: "Extension not configured" },
    };
  }

  if (config.runMode === "direct") {
    if (wallet.address === null) {
      return { ok: false, error: { code: 4100, message: "Wallet locked" } };
    }
    if (directLoopRunning) {
      return { ok: true, mode: "direct", note: "already running" };
    }
    directLoopRunning = true;
    void (async () => {
      try {
        const rpc = new RpcClient(config.rpcUrl);
        await runDirect({
          config,
          wallet: {
            address: wallet.address,
            signMessage: (msg) => wallet.signMessage(msg),
            signTransaction: (tx) => wallet.signTransaction(tx),
          },
          rpc,
          api: evoEvoApi,
          log,
          onEvent: (event) =>
            chrome.runtime.sendMessage({ type: "direct-event", event }),
          isPaused: () => paused,
        });
      } finally {
        directLoopRunning = false;
      }
    })();
    return { ok: true, mode: "direct", started: true };
  }

  const settings = await currentAutomationSettings();
  const tabsNotified = await broadcastStartToEvoEvoTabs(settings);
  return { ok: true, mode: "dom", tabsNotified };
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

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true;
  });
}

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
