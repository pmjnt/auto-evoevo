import { parseMessage } from "../shared/messages.js";
import {
  clearPrivateKey,
  getConfig,
  setConfig as persistConfig,
  setPrivateKey,
} from "./storage.js";
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
let lastRunStatus: "idle" | "running" | "done" | "error" = "idle";
let stopResolve: (() => void) | null = null;

const ROUND_INTERVAL_MS = 30_000;

// Persist the SIWE token across service-worker restarts. Lives in
// chrome.storage.session so it is cleared when the user closes Chrome
// entirely but survives the worker idling out.
const SESSION_AUTH_KEY = "evoevo-auth";
const evoEvoApi = new EvoEvoApiClient({
  tokenStorage: {
    load: async (): Promise<SiweAuth | null> => {
      if (typeof chrome === "undefined" || !chrome.storage?.session?.get) return null;
      const stored = (await chrome.storage.session.get(SESSION_AUTH_KEY)) as Record<
        string,
        SiweAuth | undefined
      >;
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

async function stopAndWait(): Promise<void> {
  if (!directLoopRunning) return;
  paused = true;
  await new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
}

export async function handleMessage(raw: unknown): Promise<RouterResponse> {
  let message;
  try {
    message = parseMessage(raw);
  } catch {
    return { ok: false, error: { code: -32600, message: "Invalid message" } };
  }

  switch (message.type) {
    case "set-private-key": {
      try {
        await setPrivateKey(message.privateKey);
        await wallet.reload();
        return { ok: true, address: wallet.address };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    case "clear-private-key": {
      await clearPrivateKey();
      await wallet.reload();
      await evoEvoApi.clearAuth();
      return { ok: true };
    }

    case "get-agents": {
      const ready = await wallet.ready();
      if (!ready || wallet.address === null) {
        return {
          ok: false,
          error: { code: 4100, message: "Wallet has no private key" },
        };
      }
      let chainId = 16661;
      try {
        chainId = (await getConfig())?.chainId ?? 16661;
      } catch {
        chainId = 16661;
      }
      try {
        await evoEvoApi.ensureAuth(wallet.address, (msg) =>
          wallet.signMessage(msg),
        );
        const agents = await evoEvoApi.listAgents(
          wallet.address,
          chainId,
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
      const ready = await wallet.ready();
      return {
        ok: true,
        ready,
        address: wallet.address,
        paused,
        running: directLoopRunning,
        lastRunStatus,
        counts: await log.counts(),
      };
    }

    case "get-config":
      return { ok: true, config: await getConfig() };

    case "pause":
      paused = true;
      return { ok: true };

    case "resume":
      paused = false;
      return await startAutomation();

    case "start": {
      await stopAndWait();
      paused = false;
      await log.clear();
      lastRunStatus = "idle";
      return await startAutomation();
    }

    case "stop":
      paused = true;
      return { ok: true };

    case "set-config":
      await persistConfig(message.config);
      return { ok: true };

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
  const ready = await wallet.ready();
  if (!ready || wallet.address === null) {
    return {
      ok: false,
      error: { code: 4100, message: "Wallet has no private key — import one in Settings" },
    };
  }
  if (directLoopRunning) {
    return { ok: true, note: "already running" };
  }

  directLoopRunning = true;
  lastRunStatus = "running";
  void (async () => {
    try {
      const rpc = new RpcClient(config.rpcUrl);
      while (!paused) {
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
          onEvent: (event) => {
            void chrome.runtime
              .sendMessage({ type: "direct-event", event })
              .catch(() => undefined);
          },
          isPaused: () => paused,
        });
        if (paused) break;
        await new Promise((r) => setTimeout(r, ROUND_INTERVAL_MS));
      }
      lastRunStatus = paused ? "idle" : "done";
    } catch {
      lastRunStatus = "error";
    } finally {
      directLoopRunning = false;
      if (stopResolve) {
        stopResolve();
        stopResolve = null;
      }
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

if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}
