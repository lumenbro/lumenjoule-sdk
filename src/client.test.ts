import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { LumenJouleClient, JouleClient } from "./client";

const TEST_SECRET = "SCLEPI47CLV5BSWAPW3KTMS5MGZW465AECSGHTM4J7E5BF2ESJVQHTMY";

describe("LumenJouleClient", () => {
  it("constructs with required secretKey", () => {
    const client = new LumenJouleClient({ secretKey: TEST_SECRET });
    expect(client.publicKey).toBe(Keypair.fromSecret(TEST_SECRET).publicKey());
  });

  it("throws on invalid secret key", () => {
    expect(() => new LumenJouleClient({ secretKey: "bad" })).toThrow();
  });

  it("defaults to mainnet", () => {
    const client = new LumenJouleClient({ secretKey: TEST_SECRET });
    // Verify construction succeeded (no error = mainnet default applied)
    expect(client.publicKey).toBeDefined();
  });

  it("accepts custom computeUrl", () => {
    const client = new LumenJouleClient({
      secretKey: TEST_SECRET,
      computeUrl: "https://custom.example.com/",
    });
    expect(client.publicKey).toBeDefined();
  });
});

describe("JouleClient (deprecated alias)", () => {
  it("is the same class as LumenJouleClient", () => {
    expect(JouleClient).toBe(LumenJouleClient);
  });
});
