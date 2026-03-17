import { describe, it, expect } from "vitest";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { Ed25519AgentSigner } from "./ed25519";

// Deterministic test keypair
const TEST_SECRET = "SCLEPI47CLV5BSWAPW3KTMS5MGZW465AECSGHTM4J7E5BF2ESJVQHTMY";
const TEST_KEYPAIR = Keypair.fromSecret(TEST_SECRET);

describe("Ed25519AgentSigner", () => {
  it("constructs from secret key", () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    expect(signer.type).toBe("Ed25519");
    expect(signer.publicKey).toBe(TEST_KEYPAIR.publicKey());
  });

  it("throws on invalid secret key", () => {
    expect(() => new Ed25519AgentSigner("invalid")).toThrow();
  });

  it("signAuth returns Ed25519 proof with 64-byte signature", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const hash = Buffer.alloc(32, 0xab);

    const proof = await signer.signAuth(hash);

    expect(proof.type).toBe("Ed25519");
    expect(proof.data).toHaveProperty("signature");
    expect((proof.data as any).signature.length).toBe(64);
  });

  it("signAuth signature is verifiable", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const hash = Buffer.alloc(32, 0xcd);

    const proof = await signer.signAuth(hash);
    const sig = (proof.data as any).signature;

    // Verify with the keypair
    expect(TEST_KEYPAIR.verify(hash, sig)).toBe(true);
  });

  it("signAuth produces different signatures for different hashes", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const hash1 = Buffer.alloc(32, 0x01);
    const hash2 = Buffer.alloc(32, 0x02);

    const proof1 = await signer.signAuth(hash1);
    const proof2 = await signer.signAuth(hash2);

    expect(Buffer.from((proof1.data as any).signature).equals(
      Buffer.from((proof2.data as any).signature)
    )).toBe(false);
  });

  it("buildSignerKey returns Vec[Symbol(Ed25519), Bytes(pubkey)]", () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const signerKey = signer.buildSignerKey();

    // Should be scvVec
    const vec = signerKey.vec();
    expect(vec).not.toBeUndefined();
    expect(vec!.length).toBe(2);

    // First element: Symbol("Ed25519")
    expect(vec![0].sym()?.toString()).toBe("Ed25519");

    // Second element: Bytes(32-byte public key)
    const pubkeyBytes = vec![1].bytes();
    expect(pubkeyBytes.length).toBe(32);

    // Verify it matches the keypair's raw public key
    const expectedPubkey = StrKey.decodeEd25519PublicKey(TEST_KEYPAIR.publicKey());
    expect(Buffer.from(pubkeyBytes).equals(Buffer.from(expectedPubkey))).toBe(true);
  });

  it("buildSignerProof returns Vec[Symbol(Ed25519), Bytes(signature)]", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const hash = Buffer.alloc(32, 0xef);
    const proof = await signer.signAuth(hash);

    const proofXdr = signer.buildSignerProof(proof);

    const vec = proofXdr.vec();
    expect(vec).not.toBeUndefined();
    expect(vec!.length).toBe(2);
    expect(vec![0].sym()?.toString()).toBe("Ed25519");
    expect(vec![1].bytes().length).toBe(64);
  });
});
