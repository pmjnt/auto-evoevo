import { parseMessage } from "../shared/messages.js";
import { getConfig, setConfig as persistConfig } from "./storage.js";
import { Wallet } from "./wallet.js";
import { RpcClient } from "./rpc.js";
import { SessionLog } from "./session-log.js";
import { EvoEvoApiClient } from "./evoevo-api.js";
import type { SiweAuth } from "./siwe.js";
import { runDirect } from "./direct-runner.js";

const wallet = new Wallet();
const log = new SessionLog();
let paused = false;
let directLoopRunning = false;

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

export type RouterResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: { code: number; message: string } };

export async function handleMessage(raw: unknown): Promise<RouterResponse> {
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
      return { ok: true, address: wallet.address };
    }

    case "lock": {
      wallet.lock();
      await evoEvoApi.clearAuth();
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

    case "get-status":
      return {
        ok: true,
        locked: wallet.address === null,
        address: wallet.address,
        paused,
        running: directLoopRunning,
        counts: await log.counts(),
      };

    case "get-config":
      return { ok: true, config: await getConfig() };

    case "pause":
      paused = true;
      return { ok: true };

    case "resume":
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

    default:
      return {
        ok: false,
        error: {
          code: -32601,
          message: `Unhandled type: ${(message as { type: string }).type}`,
        },
      };
  }
}

async function startAutomation(): Promise<RouterResponse> {
  const config = await getConfig();
  if (config === null) {
    return {
      ok: false,
      error: { code: 4100, message: "Extension not configured" },
    };
  }
  if (wallet.address === null) {
    return { ok: false, error: { code: 4100, message: "Wallet locked" } };
  }
  if (directLoopRunning) {
    return { ok: true, note: "already running" };
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
  return { ok: true, started: true };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse);
    return true;
  });
}

// Click extension icon -> side panel opens (no popup). Side panel
// persists across tab switches so the user sees status while working
// elsewhere.
if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      // Older Chromes may not support the API; ignore.
    });
}
