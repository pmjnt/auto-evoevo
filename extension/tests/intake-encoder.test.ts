import { describe, it, expect } from "vitest";
import {
  encodeIntakeReasoning,
  INTAKE_REASONING_SELECTOR,
} from "../src/background/intake-encoder.js";

// Sample captured from C:/Users/pMjn/Downloads/network-log.har on
// 2026-06-20. The encoder must produce the exact same byte string
// from the matching /v1/agents/.../memories/from-opinion API response.
const SAMPLE_TX_INPUT =
  "0xa29adb250000000000000000000000008004ae533a0301cbd7508373b663756d26dfb02800000000000000000000000000000000000000000000000000000000000012240000000000000000000000000000000000000000000000000000000000411d60397c268bcf0c9ae46bd7e500da701fe92799ccc3bf18370eddad20020b0c3fce0b869d75cb43a8f4ac10166363b22cc45453322164d955e326df12c730da6db2654fbd5f069f3297d0a873c0b471d8f3bc325d2a161abd5f0a7ce7dbc3b9715c00000000000000000000000000000000000000000000000000000000000005a8000000000000000000000000000000000000000000000000000000006a37900600000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000041e0ad636ad91f5d2b55184b97008dbbf6cb4f18b193169a87d837382105f0e65c783b216a9fa68aa43beca856f4e67cb1cf2f053fb07462a2587aee790ed5029d1b00000000000000000000000000000000000000000000000000000000000000";

const SAMPLE_PAYLOAD = {
  chain_id: 16661,
  contract_address: "0x61bb71442749d13a4BB7257DfBFFf0452ae937f9",
  method: "intakeReasoningV2" as const,
  identity_registry_address: "0x8004Ae533a0301CbD7508373b663756D26DfB028",
  updater: "0x373226EB7EC2458A41520d3a375Dbf82Cc1E1c4c",
  token_id: "4644",
  source_opinion_id: "4267360",
  reasoning_hash:
    "0x397c268bcf0c9ae46bd7e500da701fe92799ccc3bf18370eddad20020b0c3fce",
  opinion_hash:
    "0x0b869d75cb43a8f4ac10166363b22cc45453322164d955e326df12c730da6db2",
  new_memory_root:
    "0x654fbd5f069f3297d0a873c0b471d8f3bc325d2a161abd5f0a7ce7dbc3b9715c",
  nonce: "1448",
  deadline: "1782026246",
  expires_at: "2026-06-21T07:17:26Z",
  signature:
    "0xe0ad636ad91f5d2b55184b97008dbbf6cb4f18b193169a87d837382105f0e65c783b216a9fa68aa43beca856f4e67cb1cf2f053fb07462a2587aee790ed5029d1b",
};

describe("encodeIntakeReasoning", () => {
  it("selector matches the on-chain function", () => {
    expect(INTAKE_REASONING_SELECTOR).toBe("0xa29adb25");
  });

  it("reproduces the sample tx input byte-for-byte", () => {
    const encoded = encodeIntakeReasoning(SAMPLE_PAYLOAD);
    expect(encoded.toLowerCase()).toBe(SAMPLE_TX_INPUT.toLowerCase());
  });
});
