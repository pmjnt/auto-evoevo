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

  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: { uuid: crypto.randomUUID(), name: "Auto EvoEvo", rdns: "ai.evoevo.auto" },
        provider,
      }),
    }),
  );

  return provider;
}
