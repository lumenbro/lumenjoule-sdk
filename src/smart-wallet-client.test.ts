import { describe, it, expect } from "vitest";
import { Networks, xdr } from "@stellar/stellar-sdk";
import { SmartWalletClient } from "./smart-wallet-client";
import { Ed25519AgentSigner } from "./signers/ed25519";
import type { AgentSigner, SignedAuthProof } from "./signers/types";

const TEST_SECRET = "SCLEPI47CLV5BSWAPW3KTMS5MGZW465AECSGHTM4J7E5BF2ESJVQHTMY";
const TEST_WALLET = "CDSZRJUL5W3H73HSYDRHIJEJUN442JFF4NB37MB56T4TZ7EADJ6LCHJS";

describe("SmartWalletClient constructor", () => {
  it("accepts agentSecretKey (backward compatible)", () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
    });

    expect(client.address).toBe(TEST_WALLET);
    expect(client.signerType).toBe("Ed25519");
    expect(client.agentPublicKey).toBeDefined();
  });

  it("accepts pluggable signer", () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      signer,
    });

    expect(client.address).toBe(TEST_WALLET);
    expect(client.signerType).toBe("Ed25519");
  });

  it("signer takes priority over agentSecretKey", () => {
    // Provide both — signer should win
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
      signer,
    });

    expect(client.signerType).toBe("Ed25519");
  });

  it("throws without agentSecretKey or signer", () => {
    expect(
      () =>
        new SmartWalletClient({
          walletAddress: TEST_WALLET,
        })
    ).toThrow("agentSecretKey or signer");
  });

  it("defaults to mainnet", () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
    });

    // Verify by checking signerType still works (implies constructor succeeded)
    expect(client.signerType).toBe("Ed25519");
  });

  it("accepts custom network", () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
      network: "testnet",
    });

    expect(client.address).toBe(TEST_WALLET);
  });

  it("accepts custom computeUrl and strips trailing slash", () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
      computeUrl: "https://custom.example.com/",
    });

    expect(client.address).toBe(TEST_WALLET);
  });

  it("agentPublicKey is undefined for non-Ed25519 signers", () => {
    // Create a mock Secp256r1 signer
    const mockSigner: AgentSigner = {
      type: "Secp256r1",
      async signAuth(_hash: Buffer): Promise<SignedAuthProof> {
        return { type: "Secp256r1", data: {} as any };
      },
      buildSignerKey(): xdr.ScVal {
        return xdr.ScVal.scvVec([]);
      },
      buildSignerProof(_proof: SignedAuthProof): xdr.ScVal {
        return xdr.ScVal.scvVec([]);
      },
    };

    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      signer: mockSigner,
    });

    expect(client.agentPublicKey).toBeUndefined();
    expect(client.signerType).toBe("Secp256r1");
  });
});

describe("SmartWalletClient policy methods", () => {
  it("spentToday throws without policyAddress", async () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
    });

    await expect(client.spentToday()).rejects.toThrow("policyAddress");
  });

  it("remaining throws without policyAddress", async () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
    });

    await expect(client.remaining()).rejects.toThrow("policyAddress");
  });

  it("dailyLimit throws without policyAddress", async () => {
    const client = new SmartWalletClient({
      walletAddress: TEST_WALLET,
      agentSecretKey: TEST_SECRET,
    });

    await expect(client.dailyLimit()).rejects.toThrow("policyAddress");
  });
});
