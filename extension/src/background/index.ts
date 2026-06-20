import { parseMessage } from "../shared/messages.js";
import {
  clearPrivateKey,
  getConfig,
  getWorkflowState,
  setConfig as persistConfig,
  setPrivateKey,
  setWorkflowState,
} from "./storage.js";
import { Wallet } from "./wallet.js";
import { RpcClient } from "./rpc.js";
import { SessionLog } from "./session-log.js";
import { EvoEvoApiClient } from "./evoevo-api.js";
import type { SiweAuth } from "./siwe.js";
import { runFeedForAgent, type RunnerResult } from "./direct-runner.js";
import { runFeedWorkflow } from "./feed-workflow.js";
import { ChromePredictionRegistry } from "./prediction-registry.js";
import { runPredictions } from "./predictions-runner.js";
import { submitIntake } from "./intake-submitter.js";
import { preparePredictionIntake } from "./prediction-submitter.js";
import { recordPredictionProgress } from "./prediction-progress.js";
import {
  WORKFLOW_ALARM_NAME,
  WorkflowCoordinator,
} from "./workflow-coordinator.js";

const wallet = new Wallet();
const log = new SessionLog();
let paused = false;
let lastRunStatus: "idle" | "running" | "done" | "error" = "idle";

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
const registry = new ChromePredictionRegistry();

export type RouterResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: { code: number; message: string } };

const coordinator: WorkflowCoordinator = new WorkflowCoordinator({
  getConfig,
  getState: getWorkflowState,
  setState: setWorkflowState,
  runFeed: async (): Promise<RunnerResult> => {
    const config = await getConfig();
    if (config === null) {
      return { kind: "failed", reason: "Extension not configured", global: true };
    }
    if (wallet.address === null) {
      return { kind: "failed", reason: "Wallet locked", global: true };
    }
    const rpc = new RpcClient(config.rpcUrl);
    return await runFeedWorkflow({
      api: evoEvoApi,
      ensureAuth: async () => await evoEvoApi.ensureAuth(
        wallet.address!,
        (message) => wallet.signMessage(message),
      ),
      walletAddress: wallet.address,
      chainId: config.chainId,
      isPaused: (): boolean => coordinator.isPaused(),
      onProgress: () => undefined,
      runAgent: async (agentId): Promise<RunnerResult> => await runFeedForAgent({
        config,
        wallet: {
          address: wallet.address,
          signMessage: (msg) => wallet.signMessage(msg),
          signTransaction: (tx) => wallet.signTransaction(tx),
        },
        rpc,
        api: evoEvoApi,
        log,
        onEvent: sendWorkflowEvent,
        isPaused: (): boolean => coordinator.isPaused(),
      }, agentId),
    });
  },
  runPredictions: async (targetAgentId, scan) => {
    const config = await getConfig();
    if (config === null) {
      return { kind: "failed", reason: "Extension not configured", global: true };
    }
    if (wallet.address === null) {
      return { kind: "failed", reason: "Wallet locked", global: true };
    }
    await evoEvoApi.ensureAuth(wallet.address, (message) =>
      wallet.signMessage(message),
    );
    const rpc = new RpcClient(config.rpcUrl);
    return await runPredictions({
      api: evoEvoApi,
      walletAddress: wallet.address,
      chainId: config.chainId,
      registry,
      checkpoint: { load: getWorkflowState, save: setWorkflowState },
      isPaused: () => coordinator.isPaused(),
      onProgress: async (update) => await recordPredictionProgress(update, {
        getState: getWorkflowState,
        setState: setWorkflowState,
        sendEvent: sendWorkflowEvent,
      }),
      submitPrediction: async (_sourceAgentId, agentId, prediction) => {
        const prepared = await preparePredictionIntake({
          api: evoEvoApi,
          config,
          log,
          sourceAgentId: _sourceAgentId,
          targetAgentId: agentId,
          predictionId: prediction.predictionId,
          opinionId: prediction.opinionId,
        });
        if (prepared.kind === "already_adopted") return prepared;
        if (prepared.kind === "rate_limited") return prepared;
        return await submitIntake(prepared.memory.reasoning_intake_with_sig, {
          config: { ...config, agentId },
          wallet: {
            address: wallet.address,
            signTransaction: (tx) => wallet.signTransaction(tx),
          },
          rpc,
          log,
        });
      },
    }, { targetAgentId, scan });
  },
});

function sendWorkflowEvent(event: unknown): void {
  void chrome.runtime
    .sendMessage({ type: "workflow-event", event })
    .catch(() => undefined);
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
      const workflow = await coordinator.status();
      return {
        ok: true,
        ready,
        address: wallet.address,
        paused: workflow.status === "paused",
        running: workflow.status === "running",
        lastRunStatus,
        counts: await log.counts(),
        workflow,
      };
    }

    case "get-config":
      return { ok: true, config: await getConfig() };

    case "pause":
      paused = true;
      await coordinator.pause();
      return { ok: true };

    case "resume":
      paused = false;
      return await startMode("feed");

    case "start": {
      return await startMode("feed");
    }

    case "stop":
      paused = true;
      await coordinator.pause();
      return { ok: true };

    case "run-feed":
      return await startMode("feed");

    case "run-predictions":
      return await startMode("predictions");

    case "run-both":
      return await startMode("both");

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

async function startMode(mode: "feed" | "predictions" | "both"): Promise<RouterResponse> {
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
      error: { code: 4100, message: "Wallet has no private key. Import one in Settings." },
    };
  }
  paused = false;
  await log.clear();
  lastRunStatus = "running";
  const result = await coordinator.start(mode);
  return { ok: true, ...result };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse);
    return true;
  });
}

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WORKFLOW_ALARM_NAME) {
      void coordinator.handleAlarm(alarm.name);
    }
  });
  void coordinator.recover();
}

if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}
