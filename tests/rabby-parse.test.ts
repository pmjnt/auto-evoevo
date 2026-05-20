import { describe, expect, test } from "vitest";

import { parseRabbyText } from "../src/rabby/parse.js";

describe("parseRabbyText", () => {
  test("parses a full EvoEvo unknown signature popup", () => {
    const text = [
      "https://evoevo.ai",
      "Unknown Signature Type",
      "Chain",
      "0G",
      "Interact contract",
      "0x61bb710000000000000000000000000000e937f9",
      "$0.0002",
      "0.000416 OG",
      "Sign",
    ].join("\n");

    expect(parseRabbyText(text)).toMatchObject({
      origin: "https://evoevo.ai",
      chain: "0G",
      contract: "0x61bb710000000000000000000000000000e937f9",
      estimatedFeeNative: 0.000416,
      hasSevereWarning: false,
      actionFingerprint: "unknown-signature-from-evoevo",
    });
  });

  test("does not parse truncated contract text as a contract", () => {
    const text = [
      "https://evoevo.ai",
      "Unknown Signature Type",
      "Chain",
      "0G",
      "Interact contract",
      "0x61bb71...e937f9",
      "0.000416 OG",
      "Sign",
    ].join("\n");

    expect(parseRabbyText(text).contract).toBeNull();
  });

  test("flags severe Rabby warnings", () => {
    const text = [
      "https://evoevo.ai",
      "High Risk",
      "Malicious address warning",
      "0.000416 OG",
    ].join("\n");

    expect(parseRabbyText(text).hasSevereWarning).toBe(true);
  });

  test("only parses a unique contract from Interact contract context", () => {
    const text = [
      "https://evoevo.ai",
      "Allowed address",
      "0x61bb710000000000000000000000000000e937f9",
      "Interact contract",
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      "0.000416 OG",
    ].join("\n");

    expect(parseRabbyText(text).contract).toBeNull();
  });

  test("does not trust multiple origins", () => {
    const text = [
      "https://evoevo.ai",
      "https://example.com",
      "Unknown Signature Type",
      "Interact contract",
      "0x61bb710000000000000000000000000000e937f9",
      "0.000416 OG",
    ].join("\n");

    expect(parseRabbyText(text)).toMatchObject({
      origin: null,
      actionFingerprint: null,
    });
  });

  test("prefers labeled fee amounts over earlier unlabeled amounts", () => {
    const text = [
      "https://evoevo.ai",
      "Interact contract",
      "0x61bb710000000000000000000000000000e937f9",
      "0.0001 OG",
      "Network fee 0.01 OG",
    ].join("\n");

    expect(parseRabbyText(text).estimatedFeeNative).toBe(0.01);
  });

  test("does not parse ambiguous unlabeled OG amounts", () => {
    const text = [
      "https://evoevo.ai",
      "Interact contract",
      "0x61bb710000000000000000000000000000e937f9",
      "0.0001 OG",
      "0.01 OG",
    ].join("\n");

    expect(parseRabbyText(text).estimatedFeeNative).toBeNull();
  });

  test("flags expanded severe warning vocabulary", () => {
    for (const warning of [
      "suspicious",
      "unsafe",
      "security alert",
      "blacklisted",
      "not verified",
    ]) {
      expect(parseRabbyText(warning).hasSevereWarning).toBe(true);
    }
  });
});
