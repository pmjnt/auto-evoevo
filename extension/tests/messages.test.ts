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

  it("parses a valid unlock", () => {
    const parsed = parseMessage({ type: "unlock", password: "p" });
    expect(parsed.type).toBe("unlock");
  });

  it("rejects an unknown type", () => {
    expect(() => parseMessage({ type: "bogus" })).toThrow();
  });

  it("rejects a missing field", () => {
    expect(() => parseMessage({ type: "unlock" })).toThrow();
  });
});
