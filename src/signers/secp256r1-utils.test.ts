import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import {
  computeKeyId,
  ensureLowS,
  derToCompact,
  buildWebAuthnSigningPayload,
  buildSecp256r1SignerKey,
  buildSecp256r1SignerProof,
} from "./secp256r1-utils";

describe("computeKeyId", () => {
  it("returns SHA256 of public key (32 bytes)", () => {
    const pubkey = Buffer.alloc(65, 0x04); // uncompressed P-256 (starts with 0x04)
    const keyId = computeKeyId(pubkey);

    expect(keyId.length).toBe(32);
    // Verify it's actually SHA256
    const expected = crypto.createHash("sha256").update(pubkey).digest();
    expect(keyId.equals(expected)).toBe(true);
  });

  it("produces different IDs for different keys", () => {
    const key1 = Buffer.alloc(65, 0x01);
    const key2 = Buffer.alloc(65, 0x02);
    expect(computeKeyId(key1).equals(computeKeyId(key2))).toBe(false);
  });
});

describe("ensureLowS", () => {
  it("passes through already-low S values unchanged", () => {
    // Small S value (well under half the curve order)
    const lowS = Buffer.alloc(32, 0x01);
    const result = ensureLowS(lowS);
    expect(result.equals(lowS)).toBe(true);
  });

  it("normalizes high-S to n - s", () => {
    // The curve order n for secp256r1
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    const halfN = n / 2n;

    // Create an S just above half N
    const highS = halfN + 1n;
    const highSBytes = Buffer.from(highS.toString(16).padStart(64, "0"), "hex");

    const result = ensureLowS(highSBytes);
    const resultBigInt = BigInt("0x" + result.toString("hex"));

    // Should be n - highS
    expect(resultBigInt).toBe(n - highS);
    // Should now be <= halfN
    expect(resultBigInt <= halfN).toBe(true);
  });

  it("treats exactly halfN as low (no-op)", () => {
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    const halfN = n / 2n;
    const halfNBytes = Buffer.from(halfN.toString(16).padStart(64, "0"), "hex");

    const result = ensureLowS(halfNBytes);
    expect(result.equals(halfNBytes)).toBe(true);
  });
});

describe("derToCompact", () => {
  it("converts a well-formed DER signature to 64-byte compact", () => {
    // Construct a valid DER signature manually
    // R = 32 bytes of 0x11, S = 32 bytes of 0x01 (low S)
    const r = Buffer.alloc(32, 0x11);
    const s = Buffer.alloc(32, 0x01);

    const der = Buffer.concat([
      Buffer.from([0x30, 68, 0x02, 32]),
      r,
      Buffer.from([0x02, 32]),
      s,
    ]);

    const compact = derToCompact(der);
    expect(compact.length).toBe(64);
    expect(compact.subarray(0, 32).equals(r)).toBe(true);
    expect(compact.subarray(32, 64).equals(s)).toBe(true);
  });

  it("strips leading zero from DER integers", () => {
    // R with leading zero (33 bytes in DER), S with leading zero
    const r = Buffer.alloc(32, 0xaa);
    const s = Buffer.alloc(32, 0x01);

    const rDer = Buffer.concat([Buffer.from([0x00]), r]); // 33 bytes
    const sDer = Buffer.concat([Buffer.from([0x00]), s]); // 33 bytes

    const der = Buffer.concat([
      Buffer.from([0x30, 70, 0x02, 33]),
      rDer,
      Buffer.from([0x02, 33]),
      sDer,
    ]);

    const compact = derToCompact(der);
    expect(compact.length).toBe(64);
    expect(compact.subarray(0, 32).equals(r)).toBe(true);
  });

  it("throws on invalid DER (missing SEQUENCE tag)", () => {
    const bad = Buffer.from([0x31, 0x04, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    expect(() => derToCompact(bad)).toThrow("missing SEQUENCE tag");
  });

  it("applies low-S normalization", () => {
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    const halfN = n / 2n;
    const highS = halfN + 100n;
    const highSBytes = Buffer.from(highS.toString(16).padStart(64, "0"), "hex");
    const r = Buffer.alloc(32, 0x11);

    const der = Buffer.concat([
      Buffer.from([0x30, 68, 0x02, 32]),
      r,
      Buffer.from([0x02, 32]),
      highSBytes,
    ]);

    const compact = derToCompact(der);
    const resultS = BigInt("0x" + compact.subarray(32, 64).toString("hex"));
    expect(resultS <= halfN).toBe(true);
    expect(resultS).toBe(n - highS);
  });
});

describe("buildWebAuthnSigningPayload", () => {
  it("returns authenticatorData, clientDataJson, signatureBase, and messageDigest", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const result = buildWebAuthnSigningPayload(authHash);

    expect(result.authenticatorData).toBeDefined();
    expect(result.clientDataJson).toBeDefined();
    expect(result.signatureBase).toBeDefined();
    expect(result.messageDigest).toBeDefined();
  });

  it("authenticatorData is 37 bytes", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { authenticatorData } = buildWebAuthnSigningPayload(authHash);
    expect(authenticatorData.length).toBe(37);
  });

  it("authenticatorData starts with SHA256(agents.lumenbro.com)", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { authenticatorData } = buildWebAuthnSigningPayload(authHash);
    const rpIdHash = crypto.createHash("sha256").update("agents.lumenbro.com").digest();
    expect(authenticatorData.subarray(0, 32).equals(rpIdHash)).toBe(true);
  });

  it("authenticatorData flags = 0x05 (UP+UV)", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { authenticatorData } = buildWebAuthnSigningPayload(authHash);
    expect(authenticatorData[32]).toBe(0x05);
  });

  it("clientDataJson contains base64url-encoded challenge", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { clientDataJson } = buildWebAuthnSigningPayload(authHash);

    const parsed = JSON.parse(clientDataJson);
    expect(parsed.type).toBe("webauthn.get");
    expect(parsed.origin).toBe("https://agents.lumenbro.com");
    expect(parsed.crossOrigin).toBe(false);
    expect(parsed.challenge).toBeDefined();

    // Verify challenge decodes back to original hash
    const challengeB64 = parsed.challenge
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const decoded = Buffer.from(challengeB64, "base64");
    expect(decoded.equals(authHash)).toBe(true);
  });

  it("signatureBase is authenticatorData || SHA256(clientDataJson)", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { authenticatorData, clientDataJson, signatureBase } =
      buildWebAuthnSigningPayload(authHash);

    const clientDataHash = crypto
      .createHash("sha256")
      .update(clientDataJson)
      .digest();
    const expected = Buffer.concat([authenticatorData, clientDataHash]);

    expect(signatureBase.equals(expected)).toBe(true);
  });

  it("messageDigest is SHA256(signatureBase)", () => {
    const authHash = Buffer.alloc(32, 0xab);
    const { signatureBase, messageDigest } =
      buildWebAuthnSigningPayload(authHash);

    const expected = crypto
      .createHash("sha256")
      .update(signatureBase)
      .digest();

    expect(messageDigest.equals(expected)).toBe(true);
  });

  it("produces different payloads for different hashes", () => {
    const hash1 = Buffer.alloc(32, 0x01);
    const hash2 = Buffer.alloc(32, 0x02);
    const r1 = buildWebAuthnSigningPayload(hash1);
    const r2 = buildWebAuthnSigningPayload(hash2);
    expect(r1.clientDataJson).not.toBe(r2.clientDataJson);
    expect(r1.messageDigest.equals(r2.messageDigest)).toBe(false);
  });
});

describe("buildSecp256r1SignerKey", () => {
  it("returns Vec[Symbol(Secp256r1), Bytes(keyId)]", () => {
    const keyId = Buffer.alloc(32, 0xaa);
    const scVal = buildSecp256r1SignerKey(keyId);

    const vec = scVal.vec();
    expect(vec).not.toBeUndefined();
    expect(vec!.length).toBe(2);
    expect(vec![0].sym()?.toString()).toBe("Secp256r1");
    expect(Buffer.from(vec![1].bytes()).equals(keyId)).toBe(true);
  });
});

describe("buildSecp256r1SignerProof", () => {
  it("returns Vec[Symbol(Secp256r1), Map{...}] with correct fields", () => {
    const proof = {
      authenticatorData: new Uint8Array(37).fill(0x01),
      clientDataJson: '{"type":"webauthn.get","challenge":"test"}',
      signature: new Uint8Array(64).fill(0x02),
      keyId: Buffer.alloc(32, 0x03),
    };

    const scVal = buildSecp256r1SignerProof(proof);
    const vec = scVal.vec();
    expect(vec).not.toBeUndefined();
    expect(vec!.length).toBe(2);
    expect(vec![0].sym()?.toString()).toBe("Secp256r1");

    // Second element is a map
    const map = vec![1].map();
    expect(map).not.toBeUndefined();
    expect(map!.length).toBe(3);

    // Verify alphabetical order: authenticator_data < client_data_json < signature
    const keys = map!.map((e) => e.key().sym()?.toString());
    expect(keys).toEqual(["authenticator_data", "client_data_json", "signature"]);
  });

  it("throws if signature is not 64 bytes", () => {
    const proof = {
      authenticatorData: new Uint8Array(37),
      clientDataJson: "{}",
      signature: new Uint8Array(32), // wrong size
      keyId: Buffer.alloc(32),
    };

    expect(() => buildSecp256r1SignerProof(proof)).toThrow("exactly 64 bytes");
  });
});
