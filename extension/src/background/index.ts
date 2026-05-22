import { parseMessage } from "../shared/messages.js";
import { getConfig, setConfig as persistConfig } from "./storage.js";
import { Wallet } from "./wallet.js";
import { RpcClient } from "./rpc.js";
import { SessionLog } from "./session-log.js";
import { runPipeline } from "./pipeline.js";

const wallet = new Wallet();
const log = new SessionLog();
let paused = false;

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
      return { ok: true, address: wallet.address };
    }

    case "lock": {
      wallet.lock();
      return { ok: true };
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

    case "pause":
      paused = true;
      return { ok: true };

    case "resume":
      paused = false;
      return { ok: true };

    case "set-config":
      await persistConfig(message.config);
      return { ok: true };

    case "rpc-request": {
      const origin = senderOrigin(sender);
      if (origin === null) {
        return { ok: false, error: { code: 4001, message: "Origin missing" } };
      }

      const config = await getConfig();
      if (config === null) {
        return { ok: false, error: { code: 4100, message: "Extension not configured" } };
      }

      if (message.method !== "eth_sendTransaction") {
        return { ok: false, error: { code: 4200, message: `Unsupported method: ${message.method}` } };
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
        return { ok: true, txHash: result.txHash };
      }
      return { ok: false, error: { code: result.errorCode, message: result.reason } };
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

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true;
  });
}
