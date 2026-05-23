// Two-mode provider:
//
//  proxy mode: another wallet (typically Rabby) already injected
//  `window.ethereum`. We wrap it with a Proxy that forwards every
//  request to the real provider EXCEPT eth_sendTransaction, which we
//  route through our own background pipeline so it can be auto-signed
//  without the host wallet's popup. Connect / eth_requestAccounts /
//  personal_sign still flow through the host wallet.
//
//  standalone mode: nothing else is injected. We install our own
//  EIP-1193 provider, announce via EIP-6963, and spoof isMetaMask so
//  registry-only pickers (Reown / WalletConnect) can still find us.
//
// Re-evaluated every 200 ms so a wallet that injects after us still
// gets wrapped.

export type EIP1193Provider = {
  isAutoEvoEvo: true;
  isMetaMask: true;
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
const WRAPPED_MARKER = Symbol.for("auto-evoevo.wrapped");

const pending = new Map<string, Pending>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

function backgroundRequest(method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    window.postMessage(
      { source: SOURCE_PAGE, target: "ext", type: "rpc-request", id, method, params },
      "*",
    );
  });
}

function installMessageBridge(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data?.source !== SOURCE_EXT || data?.target !== "page") return;

    if (data.type === "rpc-response" && typeof data.id === "string") {
      const handler = pending.get(data.id);
      if (!handler) return;
      pending.delete(data.id);
      if (data.ok) handler.resolve(data.result);
      else
        handler.reject(
          Object.assign(new Error(data.error?.message ?? "Error"), {
            code: data.error?.code ?? -1,
          }),
        );
      return;
    }

    if (data.type === "event" && typeof data.event === "string") {
      const set = listeners.get(data.event);
      if (!set) return;
      for (const listener of set) listener(data.value);
    }
  });
}

function makeStandaloneProvider(): EIP1193Provider {
  const provider: EIP1193Provider & { [WRAPPED_MARKER]?: true } = {
    isAutoEvoEvo: true,
    isMetaMask: true,
    request: async ({ method, params }) =>
      backgroundRequest(method, params ?? []),
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };
  provider[WRAPPED_MARKER] = true;
  return provider;
}

function wrapHostProvider(host: Record<string | symbol, unknown>): unknown {
  // Reuse if already wrapped (idempotent re-claim).
  if ((host as { [WRAPPED_MARKER]?: boolean })[WRAPPED_MARKER]) return host;

  return new Proxy(host, {
    get(target, prop) {
      if (prop === WRAPPED_MARKER) return true;
      if (prop === "isAutoEvoEvo") return true;
      if (prop === "request") {
        const original = target["request"] as (args: {
          method: string;
          params?: unknown[];
        }) => Promise<unknown>;
        return async (args: { method: string; params?: unknown[] }) => {
          const params = args.params ?? [];
          if (args.method === "eth_sendTransaction") {
            return backgroundRequest(args.method, params);
          }
          return original.call(target, { method: args.method, params });
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
}

function ensureProvider(standalone: EIP1193Provider): void {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (eth && (eth as { [WRAPPED_MARKER]?: boolean })[WRAPPED_MARKER]) return;

  if (eth) {
    // Foreign wallet is present. Wrap it.
    (window as unknown as { ethereum: unknown }).ethereum = wrapHostProvider(
      eth as Record<string | symbol, unknown>,
    );
    return;
  }
  // Nothing injected. Install our standalone provider.
  (window as unknown as { ethereum: unknown }).ethereum = standalone;
}

const ICON_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="6" fill="#7aa2f7"/>' +
      '<text x="12" y="16" text-anchor="middle" font-family="system-ui" font-size="11" font-weight="700" fill="#0b0e14">AE</text>' +
      "</svg>",
  );

const ANNOUNCE_DETAIL = (provider: EIP1193Provider) =>
  Object.freeze({
    info: {
      uuid: "auto-evoevo-0001-0000-0000-000000000001",
      name: "Auto EvoEvo",
      rdns: "ai.evoevo.auto",
      icon: ICON_DATA_URL,
    },
    provider,
  });

// Intercept other wallets' EIP-6963 announces in the CAPTURE phase before
// any page listener sees them, swap the announced provider for a wrapped
// copy, and re-dispatch. Reown / wagmi / RainbowKit store the wrapped
// reference and call into it for every subsequent request — including
// eth_sendTransaction, which is where we want to hijack.
const REWRAPPED_INFO_FLAG = "__autoEvoEvoWrapped";

function setupAnnounceInterception(): void {
  window.addEventListener(
    "eip6963:announceProvider",
    (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { info?: Record<string, unknown>; provider?: unknown }
        | undefined;
      if (!detail) return;

      // Skip our own re-dispatches.
      if (detail.info?.[REWRAPPED_INFO_FLAG]) return;
      if (detail.info?.["rdns"] === "ai.evoevo.auto") return;

      // Skip if the announced provider is already our wrapper.
      if ((detail.provider as { [WRAPPED_MARKER]?: boolean } | undefined)?.[WRAPPED_MARKER])
        return;

      // Stop the original event so page listeners don't see the raw
      // provider. We will immediately re-emit a wrapped copy.
      event.stopImmediatePropagation();

      const wrapped = wrapHostProvider(
        detail.provider as Record<string | symbol, unknown>,
      );
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            ...detail,
            info: { ...detail.info, [REWRAPPED_INFO_FLAG]: true },
            provider: wrapped,
          },
        }),
      );
    },
    true, // CAPTURE phase, runs before page-level listeners
  );
}

export function installProvider(): EIP1193Provider {
  installMessageBridge();
  setupAnnounceInterception();

  const standalone = makeStandaloneProvider();
  ensureProvider(standalone);

  // Re-claim periodically so a late-injecting wallet (e.g. Rabby) gets
  // wrapped instead of replacing us at window.ethereum.
  setInterval(() => ensureProvider(standalone), 200);

  // Announce our own standalone provider so pickers that support EIP-6963
  // can offer us as a separate option. Foreign announces are still
  // intercepted+wrapped above so eth_sendTransaction is hijacked regardless
  // of which wallet the user picks.
  const detail = ANNOUNCE_DETAIL(standalone);
  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail }),
    );
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();

  return standalone;
}
