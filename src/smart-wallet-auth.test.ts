import { describe, it, expect } from "vitest";
import { Address, Networks, xdr } from "@stellar/stellar-sdk";
import { buildSmartWalletAuth, buildI128 } from "./smart-wallet-auth";
import { Ed25519AgentSigner } from "./signers/ed25519";

const TEST_SECRET = "SCLEPI47CLV5BSWAPW3KTMS5MGZW465AECSGHTM4J7E5BF2ESJVQHTMY";
const TEST_WALLET = "CDSZRJUL5W3H73HSYDRHIJEJUN442JFF4NB37MB56T4TZ7EADJ6LCHJS"; // any valid C-address
const TEST_TOKEN = "CBVWPBYEDJ7GYIUHL2HITMEEWM75WAMFINIQCR4ZAFZ62ISDFBVERQCX";

describe("buildI128", () => {
  it("converts zero", () => {
    const val = buildI128(0n);
    const parts = val.i128();
    expect(BigInt(parts.hi().toString())).toBe(0n);
    expect(BigInt(parts.lo().toString())).toBe(0n);
  });

  it("converts small positive value", () => {
    const val = buildI128(5000000n);
    const parts = val.i128();
    expect(BigInt(parts.hi().toString())).toBe(0n);
    expect(BigInt(parts.lo().toString())).toBe(5000000n);
  });

  it("converts value larger than 64 bits", () => {
    const large = (1n << 64n) + 42n;
    const val = buildI128(large);
    const parts = val.i128();
    expect(BigInt(parts.hi().toString())).toBe(1n);
    expect(BigInt(parts.lo().toString())).toBe(42n);
  });

  it("round-trips through XDR", () => {
    const original = 123456789012345n;
    const scVal = buildI128(original);

    // Serialize + deserialize
    const xdrBytes = scVal.toXDR();
    const restored = xdr.ScVal.fromXDR(xdrBytes);

    const parts = restored.i128();
    const hi = BigInt(parts.hi().toString());
    const lo = BigInt(parts.lo().toString());
    const result = (hi << 64n) | lo;
    expect(result).toBe(original);
  });
});

describe("buildSmartWalletAuth", () => {
  // Build a simple transfer invocation for testing
  function makeTransferInvocation(): xdr.SorobanAuthorizedInvocation {
    return new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(TEST_TOKEN).toScAddress(),
            functionName: "transfer",
            args: [
              Address.fromString(TEST_WALLET).toScVal(),
              Address.fromString(
                "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT"
              ).toScVal(),
              buildI128(1000000n),
            ],
          })
        ),
      subInvocations: [],
    });
  }

  it("returns a valid SorobanAuthorizationEntry", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      1000,
      Networks.TESTNET
    );

    expect(entry).toBeInstanceOf(xdr.SorobanAuthorizationEntry);
  });

  it("uses sorobanCredentialsAddress with wallet's C-address", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      1000,
      Networks.TESTNET
    );

    const creds = entry.credentials();
    expect(creds.switch().name).toBe("sorobanCredentialsAddress");

    const addrCreds = creds.address();
    const scAddr = addrCreds.address();
    const addr = Address.fromScAddress(scAddr);
    expect(addr.toString()).toBe(TEST_WALLET);
  });

  it("sets expiration ledger correctly", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();
    const expirationLedger = 12345;

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      expirationLedger,
      Networks.TESTNET
    );

    const creds = entry.credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(expirationLedger);
  });

  it("signature has Vec[Map{SignerKey -> SignerProof}] format", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      1000,
      Networks.TESTNET
    );

    const sig = entry.credentials().address().signature();
    // Outer: Vec
    const outerVec = sig.vec();
    expect(outerVec).not.toBeUndefined();
    expect(outerVec!.length).toBe(1);

    // Inner: Map with one entry
    const map = outerVec![0].map();
    expect(map).not.toBeUndefined();
    expect(map!.length).toBe(1);

    // Key: SignerKey (Vec[Symbol("Ed25519"), Bytes(pubkey)])
    const signerKey = map![0].key();
    const keyVec = signerKey.vec();
    expect(keyVec![0].sym()?.toString()).toBe("Ed25519");
    expect(keyVec![1].bytes().length).toBe(32);

    // Value: SignerProof (Vec[Symbol("Ed25519"), Bytes(sig)])
    const signerProof = map![0].val();
    const proofVec = signerProof.vec();
    expect(proofVec![0].sym()?.toString()).toBe("Ed25519");
    expect(proofVec![1].bytes().length).toBe(64);
  });

  it("preserves rootInvocation", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      1000,
      Networks.TESTNET
    );

    const rootInv = entry.rootInvocation();
    const contractFn = rootInv.function().contractFn();
    expect(contractFn.functionName().toString()).toBe("transfer");
  });

  it("serializes to XDR and back without loss", async () => {
    const signer = new Ed25519AgentSigner(TEST_SECRET);
    const invocation = makeTransferInvocation();

    const entry = await buildSmartWalletAuth(
      TEST_WALLET,
      signer,
      invocation,
      2000,
      Networks.PUBLIC
    );

    const xdrBytes = entry.toXDR("base64");
    const restored = xdr.SorobanAuthorizationEntry.fromXDR(xdrBytes, "base64");

    expect(restored.credentials().address().signatureExpirationLedger()).toBe(2000);
    expect(
      Address.fromScAddress(restored.credentials().address().address()).toString()
    ).toBe(TEST_WALLET);
  });
});
