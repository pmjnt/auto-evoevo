import { AbiCoder, id as keccakId } from "ethers";

import type { ReasoningIntakeWithSig } from "./evoevo-api.js";

// Selector verified against a real on-chain tx — see the spec.
export const INTAKE_REASONING_SIG =
  "intakeReasoningV2(address,uint256,uint256,bytes32,bytes32,bytes32,uint256,uint256,bytes)";
export const INTAKE_REASONING_SELECTOR = keccakId(INTAKE_REASONING_SIG).slice(0, 10);

const ABI_TYPES = [
  "address", // identityRegistry
  "uint256", // tokenId
  "uint256", // sourceOpinionId
  "bytes32", // reasoningHash
  "bytes32", // opinionHash
  "bytes32", // newMemoryRoot
  "uint256", // nonce
  "uint256", // deadline
  "bytes",   // signature
];

// Encode the call data the contract expects. The args come straight
// from the EvoEvo backend's `reasoning_intake_with_sig` payload — the
// backend already signed everything, our wallet just has to broadcast.
export function encodeIntakeReasoning(payload: ReasoningIntakeWithSig): string {
  if (payload.method !== "intakeReasoningV2") {
    throw new Error(`Unsupported EvoEvo intake method: ${payload.method}`);
  }

  const encoded = AbiCoder.defaultAbiCoder().encode(ABI_TYPES, [
    payload.identity_registry_address,
    BigInt(payload.token_id),
    BigInt(payload.source_opinion_id),
    payload.reasoning_hash,
    payload.opinion_hash,
    payload.new_memory_root,
    BigInt(payload.nonce),
    BigInt(payload.deadline),
    payload.signature,
  ]);
  return INTAKE_REASONING_SELECTOR + encoded.slice(2);
}
