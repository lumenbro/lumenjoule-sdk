/**
 * Shared Secp256r1 utilities: WebAuthn synthetic data, DER→compact, low-S, XDR builders.
 *
 * Used by both KeypoSigner (hardware SE) and SoftP256Signer (software dev keys).
 * Ported from agents-portal/lib/keypo-signer.ts + agents-portal/lib/passkey/crossmint-webauthn.ts
 */

import * as crypto from "crypto";
import { xdr } from "@stellar/stellar-sdk";
import type { Secp256r1Proof } from "./types";

// RP ID for synthetic WebAuthn attestation — matches agents.lumenbro.com
const SYNTHETIC_RP_ID = "agents.lumenbro.com";
const SYNTHETIC_ORIGIN = "https://agents.lumenbro.com";

// secp256r1 curve order N (for low-S normalization)
const SECP256R1_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const SECP256R1_HALF_N = SECP256R1_N / 2n;

/**
 * Compute deterministic key_id from uncompressed public key.
 * Convention: key_id = SHA256(uncompressed_65_byte_public_key)
 */
export function computeKeyId(publicKey: Buffer): Buffer {
  return crypto.createHash("sha256").update(publicKey).digest();
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build synthetic WebAuthn authenticator_data (37 bytes minimum).
 *
 * Format: rpIdHash(32) + flags(1) + counter(4)
 *  - rpIdHash: SHA256 of RP ID
 *  - flags: 0x05 = UP (user present) + UV (user verified)
 *  - counter: 0x00000001 (non-zero to look realistic)
 */
function buildSyntheticAuthenticatorData(): Buffer {
  const rpIdHash = crypto
    .createHash("sha256")
    .update(SYNTHETIC_RP_ID)
    .digest();
  const flags = Buffer.from([0x05]); // UP + UV
  const counter = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat([rpIdHash, flags, counter]);
}

/**
 * Build synthetic client_data_json with embedded challenge.
 * The smart wallet contract extracts the challenge and verifies it
 * matches the expected soroban auth hash.
 */
function buildSyntheticClientDataJson(challenge: Buffer): string {
  const challengeB64Url = toBase64Url(challenge);
  return JSON.stringify({
    type: "webauthn.get",
    challenge: challengeB64Url,
    origin: SYNTHETIC_ORIGIN,
    crossOrigin: false,
  });
}

/**
 * Build the complete WebAuthn signing payload from a Soroban auth hash.
 *
 * Returns:
 * - authenticatorData: 37-byte synthetic attestation
 * - clientDataJson: JSON string with embedded challenge
 * - signatureBase: authenticatorData || SHA256(clientDataJson)
 *   Pass this to crypto.sign('SHA256', signatureBase, key) — Node.js hashes once.
 * - messageDigest: SHA256(signatureBase)
 *   Pass this to raw/pre-hashed signers (e.g., keypo-signer CLI) that don't hash internally.
 *   Also what the contract passes to verify_sig_ecdsa_secp256r1.
 */
export function buildWebAuthnSigningPayload(authHash: Buffer): {
  authenticatorData: Buffer;
  clientDataJson: string;
  signatureBase: Buffer;
  messageDigest: Buffer;
} {
  const authenticatorData = buildSyntheticAuthenticatorData();
  const clientDataJson = buildSyntheticClientDataJson(authHash);
  const clientDataHash = crypto
    .createHash("sha256")
    .update(clientDataJson)
    .digest();
  const signatureBase = Buffer.concat([authenticatorData, clientDataHash]);
  const messageDigest = crypto
    .createHash("sha256")
    .update(signatureBase)
    .digest();
  return { authenticatorData, clientDataJson, signatureBase, messageDigest };
}

// ─── DER → Compact + Low-S ────────────────────────────────────────

/**
 * Ensure ECDSA S value is in low form (required by Soroban verify_sig_ecdsa_secp256r1).
 * If s > n/2, replace with n - s (BIP-62 / RFC 6979 normalization).
 */
export function ensureLowS(sBytes: Buffer): Buffer {
  const s = BigInt("0x" + sBytes.toString("hex"));
  if (s > SECP256R1_HALF_N) {
    const normalized = SECP256R1_N - s;
    return Buffer.from(normalized.toString(16).padStart(64, "0"), "hex");
  }
  return sBytes;
}

/**
 * Convert ASN.1 DER ECDSA signature to compact 64-byte format with low-S normalization.
 * DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
 */
export function derToCompact(derSignature: Buffer): Buffer {
  let offset = 0;

  if (derSignature[offset++] !== 0x30) {
    throw new Error("Invalid DER signature: missing SEQUENCE tag");
  }

  // Skip total length (may be 1 or 2 bytes)
  const totalLen = derSignature[offset++];
  if (totalLen & 0x80) {
    offset += totalLen & 0x7f;
  }

  // Read R
  if (derSignature[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: missing INTEGER tag for R");
  }
  const rLen = derSignature[offset++];
  let r = derSignature.subarray(offset, offset + rLen);
  offset += rLen;

  // Read S
  if (derSignature[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: missing INTEGER tag for S");
  }
  const sLen = derSignature[offset++];
  let s = derSignature.subarray(offset, offset + sLen);

  // Remove leading zero padding (ASN.1 uses it for positive integers)
  if (r.length === 33 && r[0] === 0x00) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0x00) s = s.subarray(1);

  // Pad to 32 bytes
  const rPadded = Buffer.alloc(32);
  r.copy(rPadded, 32 - r.length);

  const sPadded = Buffer.alloc(32);
  s.copy(sPadded, 32 - s.length);

  // Low-S normalization
  return Buffer.concat([rPadded, ensureLowS(sPadded)]);
}

// ─── XDR Builders ─────────────────────────────────────────────────

/**
 * Build Secp256r1 SignerKey XDR: Vec[Symbol("Secp256r1"), Bytes(key_id)]
 */
export function buildSecp256r1SignerKey(keyId: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvBytes(keyId),
  ]);
}

/**
 * Build Secp256r1 SignerProof XDR:
 * Vec[Symbol("Secp256r1"), Map{authenticator_data, client_data_json, signature}]
 *
 * Map entries MUST be alphabetically sorted (XDR canonical order).
 * Signature must be exactly 64 bytes (BytesN<64>).
 */
export function buildSecp256r1SignerProof(proof: Secp256r1Proof): xdr.ScVal {
  const signatureBytes = Buffer.from(proof.signature);
  if (signatureBytes.length !== 64) {
    throw new Error(
      `Signature must be exactly 64 bytes, got ${signatureBytes.length}`
    );
  }

  const mapEntries = [
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("authenticator_data"),
      val: xdr.ScVal.scvBytes(Buffer.from(proof.authenticatorData)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("client_data_json"),
      val: xdr.ScVal.scvBytes(Buffer.from(proof.clientDataJson, "utf8")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature"),
      val: xdr.ScVal.scvBytes(signatureBytes),
    }),
  ];

  // Sort alphabetically (already in order, but enforce)
  mapEntries.sort((a, b) => {
    const aSym = a.key().sym()?.toString() || "";
    const bSym = b.key().sym()?.toString() || "";
    return aSym.localeCompare(bSym);
  });

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvMap(mapEntries),
  ]);
}
