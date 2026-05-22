import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { encryptVault } from "../src/shared/crypto.js";
import { setVault } from "../src/background/storage.js";
import { Wallet } from "../src/background/wallet.js";

const TEST_KEY = "0x" + "11".repeat(32); // ethers-valid 32-byte key

describe("wallet", () => {
  beforeEach(async () => {
    installFakeChromeApi();
    const vault = await encryptVault(TEST_KEY, "password-123");
    await setVault(vault);
  });

  it("starts locked", async () => {
    const wallet = new Wallet();
    expect(wallet.address).toBeNull();
    await expect(
      wallet.signTransaction({
        to: "0x" + "ab".repeat(20),
        data: "0xd0e30db0",
        value: 0n,
        nonce: 0,
        gasLimit: 21000n,
        gasPrice: 1n,
        chainId: 16661,
      }),
    ).rejects.toThrow(/locked/i);
  });

  it("unlocks with correct password and exposes address", async () => {
    const wallet = new Wallet();
    const result = await wallet.unlock("password-123");
    expect(result.ok).toBe(true);
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("returns ok:false on wrong password and stays locked", async () => {
    const wallet = new Wallet();
    const result = await wallet.unlock("wrong");
    expect(result.ok).toBe(false);
    expect(wallet.address).toBeNull();
  });

  it("signs a transaction once unlocked", async () => {
    const wallet = new Wallet();
    await wallet.unlock("password-123");
    const signed = await wallet.signTransaction({
      to: "0x" + "ab".repeat(20),
      data: "0xd0e30db0",
      value: 0n,
      nonce: 0,
      gasLimit: 21000n,
      gasPrice: 1n,
      chainId: 16661,
    });
    expect(signed).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("locks again after lock() and rejects subsequent sign", async () => {
    const wallet = new Wallet();
    await wallet.unlock("password-123");
    wallet.lock();
    expect(wallet.address).toBeNull();
    await expect(
      wallet.signTransaction({
        to: "0x" + "ab".repeat(20),
        data: "0xd0e30db0",
        value: 0n,
        nonce: 0,
        gasLimit: 21000n,
        gasPrice: 1n,
        chainId: 16661,
      }),
    ).rejects.toThrow(/locked/i);
  });
});
