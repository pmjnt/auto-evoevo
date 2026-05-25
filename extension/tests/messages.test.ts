import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/shared/messages.js";

describe("messages schema", () => {
  it("parses a valid rpc-request", () => {
    const parsed = parseMessage({
      type: "rpc-request",
      id: "abc-1",
      method: "eth_sendTransaction",
      params: [{ to: "0x" + "ab".repeat(20), data: "0xd0e30db0", value: "0x0" }],
    });
    expect(parsed.type).toBe("rpc-request");
  });

  it("parses a valid set-private-key", () => {
    const parsed = parseMessage({
      type: "set-private-key",
      privateKey: "0x" + "11".repeat(32),
    });
    expect(parsed.type).toBe("set-private-key");
  });

  it("parses a valid get-config request", () => {
    const parsed = parseMessage({ type: "get-config" });
    expect(parsed.type).toBe("get-config");
  });

  it("rejects an unknown type", () => {
    expect(() => parseMessage({ type: "bogus" })).toThrow();
  });

  it("rejects a malformed private key", () => {
    expect(() =>
      parseMessage({ type: "set-private-key", privateKey: "not-hex" }),
    ).toThrow();
  });
});
