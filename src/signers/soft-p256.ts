/**
 * SoftP256Signer — Cross-platform software P-256 signer for development/testing.
 *
 * Uses Node.js crypto module for key generation and signing.
 * Private key stored encrypted (AES-256-GCM + PBKDF2) on disk.
 *
 * This signer produces the same WebAuthn-compatible format as KeypoSigner,
 * enabling local development and testing on Windows/WSL2/Linux without
 * hardware Secure Enclave access.
 *
 * For production use on macOS, prefer KeypoSigner (hardware-bound keys).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { xdr } from "@stellar/stellar-sdk";
import type { AgentSigner, SignedAuthProof, Secp256r1Proof } from "./types";
import {
  computeKeyId,
  buildWebAuthnSigningPayload,
  derToCompact,
  buildSecp256r1SignerKey,
  buildSecp256r1SignerProof,
} from "./secp256r1-utils";

const DEFAULT_KEY_DIR = path.join(os.homedir(), ".lumenjoule");
const DEFAULT_KEY_FILE = "agent-key.enc";
const PBKDF2_ITERATIONS = 100_000;

interface EncryptedKeyFile {
  version: 1;
  publicKey: string; // base64, 65 bytes uncompressed
  encryptedPrivateKey: string; // base64, AES-GCM encrypted PKCS8 + auth tag
  salt: string; // base64, 32 bytes
  iv: string; // base64, 12 bytes
}

export class SoftP256Signer implements AgentSigner {
  readonly type = "Secp256r1" as const;
  private privateKey: crypto.KeyObject;
  private publicKeyUncompressed: Buffer;
  private keyId: Buffer;

  private constructor(
    privateKey: crypto.KeyObject,
    publicKeyUncompressed: Buffer
  ) {
    this.privateKey = privateKey;
    this.publicKeyUncompressed = publicKeyUncompressed;
    this.keyId = computeKeyId(publicKeyUncompressed);
  }

  /**
   * Generate a new software P-256 key pair and save encrypted to disk.
   *
   * @param password - Password for key encryption
   * @param keyPath - File path (default: ~/.lumenjoule/agent-key.enc)
   */
  static async generate(
    password: string,
    keyPath?: string
  ): Promise<SoftP256Signer> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });

    // Extract uncompressed public key (65 bytes: 0x04 || X || Y)
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const publicKeyUncompressed = extractUncompressedP256(pubDer);

    // Encrypt and save to disk
    const filePath = keyPath || path.join(DEFAULT_KEY_DIR, DEFAULT_KEY_FILE);
    saveEncryptedKey(privateKey, publicKeyUncompressed, password, filePath);

    return new SoftP256Signer(privateKey, publicKeyUncompressed);
  }

  /**
   * Load an existing encrypted P-256 key from disk.
   *
   * @param password - Password to decrypt
   * @param keyPath - File path (default: ~/.lumenjoule/agent-key.enc)
   */
  static async load(
    password: string,
    keyPath?: string
  ): Promise<SoftP256Signer> {
    const filePath = keyPath || path.join(DEFAULT_KEY_DIR, DEFAULT_KEY_FILE);
    const content = fs.readFileSync(filePath, "utf-8");
    const keyFile: EncryptedKeyFile = JSON.parse(content);

    if (keyFile.version !== 1) {
      throw new Error(`Unsupported key file version: ${keyFile.version}`);
    }

    const salt = Buffer.from(keyFile.salt, "base64");
    const iv = Buffer.from(keyFile.iv, "base64");
    const encrypted = Buffer.from(keyFile.encryptedPrivateKey, "base64");
    const publicKeyUncompressed = Buffer.from(keyFile.publicKey, "base64");

    // Derive decryption key
    const derivedKey = crypto.pbkdf2Sync(
      password,
      salt,
      PBKDF2_ITERATIONS,
      32,
      "sha256"
    );

    // Decrypt (AES-256-GCM, last 16 bytes are auth tag)
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    // Import private key from PKCS8 DER
    const privateKey = crypto.createPrivateKey({
      key: decrypted,
      format: "der",
      type: "pkcs8",
    });

    return new SoftP256Signer(privateKey, publicKeyUncompressed);
  }

  /** Get the uncompressed public key (65 bytes: 0x04 || X || Y) */
  getPublicKey(): Buffer {
    return this.publicKeyUncompressed;
  }

  /** Get the key ID (SHA256 of uncompressed public key) */
  getKeyId(): Buffer {
    return this.keyId;
  }

  async signAuth(authHash: Buffer): Promise<SignedAuthProof> {
    if (authHash.length !== 32) {
      throw new Error(`Auth hash must be 32 bytes, got ${authHash.length}`);
    }

    const { authenticatorData, clientDataJson, signatureBase } =
      buildWebAuthnSigningPayload(authHash);

    // Sign with SHA-256: crypto.sign('SHA256', signatureBase, key) hashes once internally,
    // producing a signature over SHA256(signatureBase) = SHA256(authData || SHA256(clientDataJson)).
    // This matches what Soroban's verify_sig_ecdsa_secp256r1 verifies against.
    const derSignature = crypto.sign("SHA256", signatureBase, {
      key: this.privateKey,
      dsaEncoding: "der",
    });

    // Convert DER to compact 64-byte format with low-S normalization
    const compactSig = derToCompact(Buffer.from(derSignature));

    return {
      type: "Secp256r1",
      data: {
        authenticatorData: new Uint8Array(authenticatorData),
        clientDataJson,
        signature: new Uint8Array(compactSig),
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

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Extract uncompressed P-256 public key (65 bytes) from SPKI DER encoding.
 * The key is the last 65 bytes of the DER structure.
 */
function extractUncompressedP256(spkiDer: Buffer): Buffer {
  const uncompressed = spkiDer.subarray(spkiDer.length - 65);
  if (uncompressed[0] !== 0x04) {
    throw new Error("Expected uncompressed P-256 public key (0x04 prefix)");
  }
  return Buffer.from(uncompressed);
}

function saveEncryptedKey(
  privateKey: crypto.KeyObject,
  publicKeyUncompressed: Buffer,
  password: string,
  filePath: string
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Export private key as PKCS8 DER
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });

  // Encrypt with AES-256-GCM
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(pkcs8Der),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const keyFile: EncryptedKeyFile = {
    version: 1,
    publicKey: publicKeyUncompressed.toString("base64"),
    encryptedPrivateKey: Buffer.concat([ciphertext, authTag]).toString(
      "base64"
    ),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
  };

  fs.writeFileSync(filePath, JSON.stringify(keyFile, null, 2), {
    mode: 0o600,
  });
}
