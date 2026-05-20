import type { WalletRequest } from "../types.js";

export const FULL_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;
export const FEE_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*OG\b/i;
export const SEVERE_WARNING_PATTERN =
  /(high risk|malicious|phishing|scam|dangerous|drain|suspicious|unsafe|security alert|blacklisted|not verified)/i;

const EVOEVO_ORIGIN = "https://evoevo.ai";
const URL_PATTERN = /https?:\/\/[^\s]+/g;
const INTERACT_CONTRACT_PATTERN = /Interact contract/i;
const FEE_LABEL_PATTERN = /(fee|gas|network)/i;
const CONTRACT_CONTEXT_LINE_LIMIT = 4;

function trimUrlPunctuation(url: string): string {
  return url.replace(/[),.;\]}>'"]+$/g, "");
}

function parseOrigin(rawText: string): string | null {
  const origins = new Set(
    Array.from(rawText.matchAll(URL_PATTERN), ([url]) =>
      trimUrlPunctuation(url),
    ),
  );

  if (origins.size !== 1) {
    return null;
  }

  const [origin] = origins;
  return origin === EVOEVO_ORIGIN ? EVOEVO_ORIGIN : null;
}

function findAllFullAddresses(text: string): string[] {
  const globalAddressPattern = new RegExp(FULL_ADDRESS_PATTERN.source, "g");
  return Array.from(text.matchAll(globalAddressPattern), ([address]) =>
    address.toLowerCase(),
  );
}

function parseContract(rawText: string): string | null {
  const lines = rawText.split(/\r?\n/);
  const labelIndex = lines.findIndex((line) =>
    INTERACT_CONTRACT_PATTERN.test(line),
  );

  if (labelIndex === -1) {
    return null;
  }

  const uniqueAddresses = new Set(findAllFullAddresses(rawText));

  if (uniqueAddresses.size !== 1) {
    return null;
  }

  const [contract] = uniqueAddresses;
  const contextText = lines
    .slice(labelIndex, labelIndex + CONTRACT_CONTEXT_LINE_LIMIT + 1)
    .join("\n");
  const contextAddresses = new Set(findAllFullAddresses(contextText));

  return contextAddresses.has(contract) ? contract : null;
}

function parseOgAmounts(text: string): number[] {
  const globalFeePattern = new RegExp(FEE_PATTERN.source, "gi");

  return Array.from(text.matchAll(globalFeePattern), ([, amount]) =>
    Number.parseFloat(amount),
  ).filter((amount) => Number.isFinite(amount) && amount >= 0);
}

function parseEstimatedFeeNative(rawText: string): number | null {
  const lines = rawText.split(/\r?\n/);
  const labeledFeeAmounts = lines
    .filter((line) => FEE_LABEL_PATTERN.test(line))
    .flatMap((line) => parseOgAmounts(line));

  if (labeledFeeAmounts.length > 0) {
    return labeledFeeAmounts.length === 1 ? labeledFeeAmounts[0] : null;
  }

  const unlabeledAmounts = parseOgAmounts(rawText);
  return unlabeledAmounts.length === 1 ? unlabeledAmounts[0] : null;
}

export function parseRabbyText(rawText: string): WalletRequest {
  const origin = parseOrigin(rawText);
  const chain = /\b0G\b/.test(rawText) ? "0G" : null;
  const contract = parseContract(rawText);
  const estimatedFeeNative = parseEstimatedFeeNative(rawText);
  const hasSevereWarning = SEVERE_WARNING_PATTERN.test(rawText);
  const actionFingerprint =
    origin === EVOEVO_ORIGIN && /Unknown Signature Type/i.test(rawText)
      ? "unknown-signature-from-evoevo"
      : null;

  return {
    origin,
    chain,
    contract,
    estimatedFeeNative,
    hasSevereWarning,
    actionFingerprint,
    rawText,
  };
}
