// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { installProvider, type EIP1193Provider } from "../src/inpage/provider.js";

describe("inpage provider", () => {
  beforeEach(() => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("does not throw when window.ethereum is a getter-only property", () => {
    const host = {
      request: vi.fn(async () => "0x41"),
    };
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get: () => host,
    });

    expect(() => installProvider()).not.toThrow();
    expect((window as unknown as { ethereum?: EIP1193Provider }).ethereum?.isAutoEvoEvo).toBe(true);
  });

  it("posts an rpc message and resolves on matching response", async () => {
    const provider: EIP1193Provider = installProvider();
    const requestPromise = provider.request({ method: "eth_chainId" });
    const sent = await captureLastPostMessage();
    expect(sent.type).toBe("rpc-request");
    expect(sent.method).toBe("eth_chainId");

    window.postMessage(
      { source: "auto-evoevo-ext", target: "page", type: "rpc-response", id: sent.id, ok: true, result: "0x41" },
      "*",
    );

    expect(await requestPromise).toBe("0x41");
  });

  it("rejects with thrown error on error response", async () => {
    const provider = installProvider();
    const requestPromise = provider.request({ method: "personal_sign", params: ["0x", "0x"] });
    const sent = await captureLastPostMessage();
    window.postMessage(
      {
        source: "auto-evoevo-ext",
        target: "page",
        type: "rpc-response",
        id: sent.id,
        ok: false,
        error: { code: 4200, message: "Unsupported" },
      },
      "*",
    );
    await expect(requestPromise).rejects.toMatchObject({ code: 4200 });
  });

  it("fires chainChanged listeners", async () => {
    const provider = installProvider();
    const cb = vi.fn();
    provider.on("chainChanged", cb);
    window.postMessage(
      { source: "auto-evoevo-ext", target: "page", type: "event", event: "chainChanged", value: "0x41" },
      "*",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith("0x41");
  });
});

async function captureLastPostMessage(): Promise<{ id: string; method: string; type: string }> {
  return await new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.source === "auto-evoevo-page" && data?.target === "ext" && data?.type === "rpc-request") {
        window.removeEventListener("message", onMessage);
        resolve(data);
      }
    };
    window.addEventListener("message", onMessage);
  });
}
