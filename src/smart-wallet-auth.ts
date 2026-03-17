/**
 * Smart wallet auth builder for C-address (contract) authentication.
 *
 * Builds SorobanAuthorizationEntry with pluggable signer support.
 * Works with Ed25519 SignerKey/SignerProof format (OZ smart account)
 * and Secp256r1 SignerKey/SignerProof format (WebAuthn / SE keys).
 *
 * Pattern proven working: soroban-policies/scripts/test-oz-facilitator-compat.ts
 */

import {
  Address,
  xdr,
  hash as stellarHash,
} from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import type { AgentSigner } from "./signers/types";

/**
 * Generate a random nonce for auth entry (positive i64).
 */
function makeNonce(): xdr.Int64 {
  const bytes = crypto.randomBytes(8);
  bytes[0] &= 0x7f; // ensure positive
  return xdr.Int64.fromString(
    BigInt("0x" + bytes.toString("hex")).toString()
  );
}

/**
 * Build i128 ScVal from bigint.
 */
export function buildI128(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString((value >> 64n).toString()),
      lo: xdr.Uint64.fromString(
        (value & BigInt("0xFFFFFFFFFFFFFFFF")).toString()
      ),
    })
  );
}

/**
 * Build a pre-signed SorobanAuthorizationEntry for a C-address smart wallet.
 *
 * Uses the pluggable AgentSigner interface to support both:
 * - Ed25519: Vec[Symbol("Ed25519"), Bytes(pubkey/sig)]
 * - Secp256r1: Vec[Symbol("Secp256r1"), Bytes(keyId)] + Map{authenticator_data, ...}
 *
 * Format: SignatureProofs = Vec[Map{SignerKey -> SignerProof}]
 *
 * The auth entry is signed over the Soroban authorization preimage, NOT the TX envelope.
 * This allows the facilitator to rebuild the TX with its own source account
 * while preserving the C-address auth entries.
 */
export async function buildSmartWalletAuth(
  walletAddress: string,
  signer: AgentSigner,
  invocation: xdr.SorobanAuthorizedInvocation,
  expirationLedger: number,
  networkPassphrase: string
): Promise<xdr.SorobanAuthorizationEntry> {
  const nonce = makeNonce();
  const networkIdHash = stellarHash(Buffer.from(networkPassphrase, "utf-8"));

  // Build the authorization preimage and hash it
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: networkIdHash,
      nonce,
      signatureExpirationLedger: expirationLedger,
      invocation,
    })
  );
  const authHash = stellarHash(preimage.toXDR());

  // Sign with the pluggable signer
  const proof = await signer.signAuth(authHash);
  const signerKey = signer.buildSignerKey();
  const signerProof = signer.buildSignerProof(proof);

  // Wrap in SignatureProofs: Vec[Map{signerKey -> signerProof}]
  const signatureProofs = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: signerKey, val: signerProof }),
    ]),
  ]);

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(walletAddress).toScAddress(),
        nonce,
        signatureExpirationLedger: expirationLedger,
        signature: signatureProofs,
      })
    ),
    rootInvocation: invocation,
  });
}
