/**
 * Ed25519 agent signer — wraps Keypair.fromSecret() for backward compatibility.
 *
 * This is the default signer when `agentSecretKey` is provided to SmartWalletClient.
 */

import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import type { AgentSigner, SignedAuthProof, Ed25519Proof } from "./types";

export class Ed25519AgentSigner implements AgentSigner {
  readonly type = "Ed25519" as const;
  readonly keypair: Keypair;

  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  /** Agent's Stellar public key (G-address) */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async signAuth(authHash: Buffer): Promise<SignedAuthProof> {
    const signature = this.keypair.sign(authHash);
    return {
      type: "Ed25519",
      data: { signature } as Ed25519Proof,
    };
  }

  buildSignerKey(): xdr.ScVal {
    const publicKeyBytes = StrKey.decodeEd25519PublicKey(
      this.keypair.publicKey()
    );
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Ed25519"),
      xdr.ScVal.scvBytes(Buffer.from(publicKeyBytes)),
    ]);
  }

  buildSignerProof(proof: SignedAuthProof): xdr.ScVal {
    const ed25519Proof = proof.data as Ed25519Proof;
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Ed25519"),
      xdr.ScVal.scvBytes(ed25519Proof.signature),
    ]);
  }
}
