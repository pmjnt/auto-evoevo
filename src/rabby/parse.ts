import type { WalletRequest } from "../types.js";

export const FULL_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;
export const FEE_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*OG\b/i;
export const SEVERE_WARNING_PATTERN =
  /(high risk|malicious|phishing|scam|dangerous|drain)/i;

const EVOEVO_ORIGIN = "https://evoevo.ai";

export function parseRabbyText(rawText: string): WalletRequest {
  const origin = rawText.includes(EVOEVO_ORIGIN) ? EVOEVO_ORIGIN : null;
  const chain = /\b0G\b/.test(rawText) ? "0G" : null;
  const contract = FULL_ADDRESS_PATTERN.exec(rawText)?.[0].toLowerCase() ?? null;
  const feeMatch = FEE_PATTERN.exec(rawText);
  const estimatedFeeNative =
    feeMatch === null ? null : Number.parseFloat(feeMatch[1]);
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
