import { Wallet as EthersWallet } from "ethers";

import { getPrivateKey } from "./storage.js";

export type TxToSign = {
  to: string;
  data: string;
  value: bigint;
  nonce: number;
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  chainId: number;
};

// Plaintext-key wallet. The private key sits in chrome.storage.local
// and is rehydrated on every service-worker wake. No password gate —
// distribution is controlled out-of-band (e.g. one burner wallet per
// recipient). Anyone with access to the Chrome profile has full
// access to the key by design.
export class Wallet {
  private signer: EthersWallet | null = null;

  get address(): string | null {
    return this.signer?.address ?? null;
  }

  // Rehydrate from storage. Returns true if a key is present and parsed.
  async ready(): Promise<boolean> {
    if (this.signer !== null) return true;
    const key = await getPrivateKey();
    if (key === null) return false;
    try {
      this.signer = new EthersWallet(key);
      return true;
    } catch {
      this.signer = null;
      return false;
    }
  }

  // Force reload from storage. Called after the user imports a new key.
  async reload(): Promise<void> {
    this.signer = null;
    await this.ready();
  }

  async signTransaction(tx: TxToSign): Promise<string> {
    if (!(await this.ready()) || this.signer === null) {
      throw new Error("Wallet has no private key — import one first");
    }
    return await this.signer.signTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      chainId: tx.chainId,
    });
  }

  async signMessage(message: string): Promise<string> {
    if (!(await this.ready()) || this.signer === null) {
      throw new Error("Wallet has no private key — import one first");
    }
    return await this.signer.signMessage(message);
  }
}
