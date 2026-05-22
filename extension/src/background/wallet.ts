import { Wallet as EthersWallet } from "ethers";

import { decryptVault } from "../shared/crypto.js";
import { getVault } from "./storage.js";

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

export type UnlockResult = { ok: true } | { ok: false; reason: string };

export class Wallet {
  private signer: EthersWallet | null = null;

  get address(): string | null {
    return this.signer?.address ?? null;
  }

  async unlock(password: string): Promise<UnlockResult> {
    const vault = await getVault();
    if (vault === null) return { ok: false, reason: "No vault stored" };
    try {
      const privateKey = await decryptVault(vault, password);
      this.signer = new EthersWallet(privateKey);
      return { ok: true };
    } catch {
      this.signer = null;
      return { ok: false, reason: "Wrong password" };
    }
  }

  lock(): void {
    this.signer = null;
  }

  async signTransaction(tx: TxToSign): Promise<string> {
    if (this.signer === null) {
      throw new Error("Wallet is locked");
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
}
