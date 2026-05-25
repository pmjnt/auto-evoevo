import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChromeApi } from "./fixtures/chrome-api.js";
import { setPrivateKey } from "../src/background/storage.js";
import { Wallet } from "../src/background/wallet.js";

const TEST_KEY = "0x" + "11".repeat(32);

describe("wallet (no password)", () => {
  beforeEach(() => {
    installFakeChromeApi();
  });

  it("is not ready when no key is stored", async () => {
    const wallet = new Wallet();
    expect(await wallet.ready()).toBe(false);
    expect(wallet.address).toBeNull();
  });

  it("loads the stored key on ready()", async () => {
    await setPrivateKey(TEST_KEY);
    const wallet = new Wallet();
    expect(await wallet.ready()).toBe(true);
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("signs a transaction once a key is stored", async () => {
    await setPrivateKey(TEST_KEY);
    const wallet = new Wallet();
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

  it("rejects sign attempts before a key is stored", async () => {
    const wallet = new Wallet();
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
    ).rejects.toThrow(/no private key/i);
  });

  it("reload() picks up a newly-stored key without making a new wallet", async () => {
    const wallet = new Wallet();
    expect(await wallet.ready()).toBe(false);
    await setPrivateKey(TEST_KEY);
    await wallet.reload();
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
