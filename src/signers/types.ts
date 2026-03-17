/**
 * Pluggable signer interface for SmartWalletClient.
 *
 * Supports Ed25519 (software keypair) and Secp256r1 (hardware SE / software P-256).
 * Each signer knows how to sign a Soroban auth hash and build its own XDR
 * SignerKey/SignerProof structures for the OZ smart account __check_auth format.
 */

import { xdr } from "@stellar/stellar-sdk";

export interface Ed25519Proof {
  signature: Buffer; // 64 bytes
}

export interface Secp256r1Proof {
  authenticatorData: Uint8Array; // 37 bytes
  clientDataJson: string;
  signature: Uint8Array; // 64 bytes compact R||S (low-S normalized)
  keyId: Buffer; // 32 bytes SHA256(uncompressed_pubkey)
}

export interface SignedAuthProof {
  type: "Ed25519" | "Secp256r1";
  data: Ed25519Proof | Secp256r1Proof;
}

export interface AgentSigner {
  readonly type: "Ed25519" | "Secp256r1";

  /** Sign a 32-byte Soroban auth hash. Returns signer-specific proof data. */
  signAuth(authHash: Buffer): Promise<SignedAuthProof>;

  /** Build SignerKey XDR for the SignatureProofs map */
  buildSignerKey(): xdr.ScVal;

  /** Build SignerProof XDR from signed proof data */
  buildSignerProof(proof: SignedAuthProof): xdr.ScVal;
}
