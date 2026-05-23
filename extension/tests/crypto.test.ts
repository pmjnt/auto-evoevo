import { describe, it, expect } from "vitest";
import { encryptVault, decryptVault } from "../src/shared/crypto.js";

describe("crypto vault", () => {
  it("round-trips plaintext with correct password", async () => {
    const vault = await encryptVault("secret-plaintext", "password-123");
    const decrypted = await decryptVault(vault, "password-123");
    expect(decrypted).toBe("secret-plaintext");
  });

  it("throws when password is wrong", async () => {
    const vault = await encryptVault("secret-plaintext", "password-123");
    await expect(decryptVault(vault, "wrong")).rejects.toThrow();
  });

  it("produces different ciphertexts for the same input across runs", async () => {
    const a = await encryptVault("same", "pw");
    const b = await encryptVault("same", "pw");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
  });
});
