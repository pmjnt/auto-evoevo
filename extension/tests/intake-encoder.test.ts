import { describe, it, expect } from "vitest";
import {
  encodeIntakeReasoning,
  INTAKE_REASONING_SELECTOR,
} from "../src/background/intake-encoder.js";

// Sample tx 0x7649177a... from 0G mainnet at block 0x20aaffa.
// Input data captured directly from eth_getTransactionByHash. The
// encoder must produce the exact same byte string from the matching
// /v1/agents/.../memories/from-opinion API response.
const SAMPLE_TX_INPUT =
  "0x4ed1f27500000000000000000000000000000000000000000000000000000000000012240000000000000000000000000000000000000000000000000000000000000b8c0f641752088d3f8a113f03f30c32f1768b8071078b50c120b3b1f16f9585e35a90c9b878dceb96e632ed6ed12f1199dd1930e4d264858bafa43cc22936b59af4410060fdc8c9b9be1dddde2d3709f0f8daa91d4558d75df4ab7a02df580daffc000000000000000000000000000000000000000000000000000000000000009e000000000000000000000000000000000000000000000000000000006a15125000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000041a0c3bd804bfbc20237c1cfd7425135dd5f7b02609981c2196ef698353ffa6e3f060518563577fc5d75329dc4b70c413bcb5efcebbe384456325f1b19720c2a891b00000000000000000000000000000000000000000000000000000000000000";

const SAMPLE_PAYLOAD = {
  chain_id: 16661,
  contract_address: "0x61bb71442749d13a4BB7257DfBFFf0452ae937f9",
  method: "intakeReasoning" as const,
  updater: "0x373226EB7EC2458A41520d3a375Dbf82Cc1E1c4c",
  token_id: "4644",
  source_opinion_id: "2956",
  reasoning_hash:
    "0x0f641752088d3f8a113f03f30c32f1768b8071078b50c120b3b1f16f9585e35a",
  opinion_hash:
    "0x90c9b878dceb96e632ed6ed12f1199dd1930e4d264858bafa43cc22936b59af4",
  new_memory_root:
    "0x410060fdc8c9b9be1dddde2d3709f0f8daa91d4558d75df4ab7a02df580daffc",
  nonce: "158",
  deadline: "1779765840",
  expires_at: "2026-05-26T03:24:00Z",
  signature:
    "0xa0c3bd804bfbc20237c1cfd7425135dd5f7b02609981c2196ef698353ffa6e3f060518563577fc5d75329dc4b70c413bcb5efcebbe384456325f1b19720c2a891b",
};

describe("encodeIntakeReasoning", () => {
  it("selector matches the on-chain function", () => {
    expect(INTAKE_REASONING_SELECTOR).toBe("0x4ed1f275");
  });

  it("reproduces the sample tx input byte-for-byte", () => {
    const encoded = encodeIntakeReasoning(SAMPLE_PAYLOAD);
    expect(encoded.toLowerCase()).toBe(SAMPLE_TX_INPUT.toLowerCase());
  });
});
