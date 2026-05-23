export type EIP1193Provider = {
  isAutoEvoEvo: true;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const SOURCE_PAGE = "auto-evoevo-page";
const SOURCE_EXT = "auto-evoevo-ext";

export function installProvider(): EIP1193Provider {
  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data?.source !== SOURCE_EXT || data?.target !== "page") return;

    if (data.type === "rpc-response" && typeof data.id === "string") {
      const handler = pending.get(data.id);
      if (!handler) return;
      pending.delete(data.id);
      if (data.ok) handler.resolve(data.result);
      else handler.reject(Object.assign(new Error(data.error?.message ?? "Error"), { code: data.error?.code ?? -1 }));
      return;
    }

    if (data.type === "event" && typeof data.event === "string") {
      const set = listeners.get(data.event);
      if (!set) return;
      for (const listener of set) listener(data.value);
    }
  });

  const provider: EIP1193Provider = {
    isAutoEvoEvo: true,
    request: async ({ method, params }) => {
      const id = crypto.randomUUID();
      return await new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.postMessage(
          { source: SOURCE_PAGE, target: "ext", type: "rpc-request", id, method, params: params ?? [] },
          "*",
        );
      });
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };

  (window as unknown as { ethereum?: EIP1193Provider }).ethereum = provider;

  // EIP-6963 wallet discovery. We announce once on install and also respond
  // to requestProvider so dApps that mount AFTER us (e.g. Reown / Web3Modal)
  // still discover the wallet. A stable uuid lets pickers dedupe across
  // multiple announces.
  const announceDetail = Object.freeze({
    info: {
      uuid: "auto-evoevo-0001-0000-0000-000000000001",
      name: "Auto EvoEvo",
      rdns: "ai.evoevo.auto",
      icon: PROVIDER_ICON_DATA_URL,
    },
    provider,
  });

  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: announceDetail }),
    );
  };

  window.addEventListener("eip6963:requestProvider", announce);
  announce();

  return provider;
}

// 24x24 purple square SVG, base64-encoded. Reown's modal requires a non-empty
// icon URL or the wallet entry is dropped silently.
const PROVIDER_ICON_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="6" fill="#7aa2f7"/>' +
      '<text x="12" y="16" text-anchor="middle" font-family="system-ui" font-size="11" font-weight="700" fill="#0b0e14">AE</text>' +
      "</svg>",
  );
