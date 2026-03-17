/**
 * KeypoSigner — Apple Secure Enclave / TPM P-256 signing via keypo-signer CLI.
 *
 * Hardware-bound keys: private key never exists in software memory.
 * Same secp256r1 curve as WebAuthn passkeys → same __check_auth path in smart wallet.
 *
 * The smart wallet contract verifies Secp256r1 signatures in WebAuthn format
 * (authenticator_data + client_data_json + signature). SE keys produce raw
 * ECDSA signatures, so this signer constructs synthetic WebAuthn attestation
 * data that wraps the SE signature. The contract verifies the math — it
 * doesn't check that authenticator_data came from a real browser.
 *
 * Ported from: agents-portal/lib/keypo-signer.ts
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { xdr } from "@stellar/stellar-sdk";
import type { AgentSigner, SignedAuthProof, Secp256r1Proof } from "./types";
import {
  computeKeyId,
  buildWebAuthnSigningPayload,
  buildSecp256r1SignerKey,
  buildSecp256r1SignerProof,
} from "./secp256r1-utils";

const execFileAsync = promisify(execFile);

export interface KeypoSignerConfig {
  /** Key label in Secure Enclave (e.g., 'agent-compute-bot-1') */
  keyLabel: string;
  /** 65-byte uncompressed public key (0x04 || X || Y) */
  publicKey: Buffer;
  /** Path to keypo-signer binary (default: 'keypo-signer' in PATH) */
  binaryPath?: string;
}

export class KeypoSigner implements AgentSigner {
  readonly type = "Secp256r1" as const;
  private keyLabel: string;
  private publicKeyBuf: Buffer;
  private keyId: Buffer;
  private binaryPath: string;

  constructor(config: KeypoSignerConfig) {
    if (config.publicKey.length !== 65 || config.publicKey[0] !== 0x04) {
      throw new Error(
        "Public key must be 65 bytes uncompressed (0x04 || X || Y)"
      );
    }
    this.keyLabel = config.keyLabel;
    this.publicKeyBuf = config.publicKey;
    this.keyId = computeKeyId(config.publicKey);
    this.binaryPath = config.binaryPath || "keypo-signer";
  }

  /** Get the key ID (SHA256 of uncompressed public key) */
  getKeyId(): Buffer {
    return this.keyId;
  }

  /** Get the uncompressed public key (65 bytes) */
  getPublicKey(): Buffer {
    return this.publicKeyBuf;
  }

  async signAuth(authHash: Buffer): Promise<SignedAuthProof> {
    if (authHash.length !== 32) {
      throw new Error(`Auth hash must be 32 bytes, got ${authHash.length}`);
    }

    const { authenticatorData, clientDataJson, messageDigest } =
      buildWebAuthnSigningPayload(authHash);

    // keypo-signer uses pre-hashed signing: pass 32-byte digest directly to SE
    // Low-S normalization is applied by keypo-signer binary
    const { stdout } = await execFileAsync(this.binaryPath, [
      "sign",
      messageDigest.toString("hex"),
      "--key",
      this.keyLabel,
    ]);

    const signature = Buffer.from(stdout.trim(), "hex");
    if (signature.length !== 64) {
      throw new Error(
        `Invalid keypo-signer output: expected 64 bytes, got ${signature.length}`
      );
    }

    return {
      type: "Secp256r1",
      data: {
        authenticatorData: new Uint8Array(authenticatorData),
        clientDataJson,
        signature: new Uint8Array(signature),
        keyId: this.keyId,
      } as Secp256r1Proof,
    };
  }

  buildSignerKey(): xdr.ScVal {
    return buildSecp256r1SignerKey(this.keyId);
  }

  buildSignerProof(proof: SignedAuthProof): xdr.ScVal {
    return buildSecp256r1SignerProof(proof.data as Secp256r1Proof);
  }
}
