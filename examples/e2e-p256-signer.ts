#!/usr/bin/env tsx
/**
 * E2E Test: SoftP256Signer → Smart Wallet → OZ Facilitator
 *
 * Proves Secp256r1 (P-256) agent signing works end-to-end:
 *   1. Generate software P-256 key (SoftP256Signer)
 *   2. Deploy smart wallet + add Secp256r1 signer with spend policy (testnet)
 *   3. Fund wallet with USDC
 *   4. Build v2 payment payload with P-256 signed auth
 *   5. Local simulation (verifies __check_auth accepts P-256 SignerKey/SignerProof)
 *   6. OZ facilitator /verify + /settle
 *   7. Verify balance decreased
 *
 * Usage (testnet, fully automated):
 *   npx tsx examples/e2e-p256-signer.ts
 *
 * Usage (mainnet, with pre-registered signer):
 *   npx tsx examples/e2e-p256-signer.ts --wallet=CXXX --network=mainnet
 *
 * The generated P-256 key is saved to ~/.lumenjoule/test-p256.enc (password: "test")
 * Public key + key_id are printed for manual registration if needed.
 */

import {
  rpc,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  StrKey,
  Contract,
  Account,
  xdr,
  hash as stellarHash,
} from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { SoftP256Signer } from "../src/signers/soft-p256";
import { buildSmartWalletAuth, buildI128 } from "../src/smart-wallet-auth";

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const walletArg = args.find((a) => a.startsWith("--wallet="));
const networkArg = args.find((a) => a.startsWith("--network="));
const generateOnly = args.includes("--generate");

const NETWORK = (networkArg?.split("=")[1] || "testnet") as "testnet" | "mainnet";

const RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

const PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const CAIP2: Record<string, string> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const USDC_SACS: Record<string, string> = {
  testnet: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  mainnet: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

// Testnet-only: factory + policy + deployer
const FACTORY_CONTRACT = "CDX5D2ADSLU5ZHEQEPRQRH7Z54LXKKMX467EQHWFK247EWDYS3WP6ICS";
const WASM_HASH = "76d2ba826c1b5a7b6cc0aaebe058cc3ffc373c2171f90d63ebb7481a28f577bd";
const V2_POLICY = "CBVBELAI6EYVG2OHKYZX24KSCA6J4IIYWBZ4QADKLHTSV2XSGEJJPWGC";
const DEPLOYER_SECRET = "SCZKOSUOKIB3CWPWEYKVUK7KGGAKUVWJWMUJ6UXXSURNDBHDNHY3VGYV";

// OZ facilitator
const OZ_BASE_URLS: Record<string, string> = {
  testnet: "https://channels.openzeppelin.com/x402/testnet",
  mainnet: "https://channels.openzeppelin.com/x402",
};

const OZ_API_KEY_URLS: Record<string, string> = {
  testnet: "https://channels.openzeppelin.com/testnet/gen",
  mainnet: "https://channels.openzeppelin.com/gen",
};

const RPC_URL = RPC_URLS[NETWORK];
const NETWORK_PASSPHRASE = PASSPHRASES[NETWORK];
const USDC_SAC = USDC_SACS[NETWORK];
const OZ_BASE_URL = OZ_BASE_URLS[NETWORK];

const server = new rpc.Server(RPC_URL);
const KEY_PATH = path.join(os.homedir(), ".lumenjoule", "test-p256.enc");
const KEY_PASSWORD = "test";

// Transfer amount: $0.10 USDC
const TRANSFER_AMOUNT = 1_000_000n; // 7-decimal stroops

// ============================================================================
// Helpers
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function makeNonce(): xdr.Int64 {
  const bytes = crypto.randomBytes(8);
  bytes[0] &= 0x7f;
  return xdr.Int64.fromString(BigInt("0x" + bytes.toString("hex")).toString());
}

async function waitForTx(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS" || status.status === "FAILED") return status;
  }
  throw new Error(`TX ${hash} not confirmed after 60s`);
}

async function getOzApiKey(): Promise<string> {
  const resp = await fetch(OZ_API_KEY_URLS[NETWORK]);
  if (!resp.ok) throw new Error(`Failed to get OZ API key: ${resp.status}`);
  const data = await resp.json();
  return (data as any).apiKey;
}

// ============================================================================
// Phase 0: Generate / Load P-256 Key
// ============================================================================

async function getOrCreateSigner(): Promise<SoftP256Signer> {
  console.log("\n--- Phase 0: P-256 Key ---");

  let signer: SoftP256Signer;
  try {
    signer = await SoftP256Signer.load(KEY_PASSWORD, KEY_PATH);
    console.log(`  Loaded existing key from ${KEY_PATH}`);
  } catch {
    console.log(`  Generating new P-256 key...`);
    signer = await SoftP256Signer.generate(KEY_PASSWORD, KEY_PATH);
    console.log(`  Saved to ${KEY_PATH}`);
  }

  const pubKey = signer.getPublicKey();
  const keyId = signer.getKeyId();
  console.log(`  Public key (base64): ${pubKey.toString("base64")}`);
  console.log(`  Key ID (base64):     ${keyId.toString("base64")}`);
  console.log(`  Key ID (hex):        ${keyId.toString("hex")}`);
  console.log(`  Signer type:         ${signer.type}`);

  return signer;
}

// ============================================================================
// Phase 1: Deploy Wallet + Add Secp256r1 Signer (testnet only)
// ============================================================================

function buildSecp256r1PolicySigner(
  publicKeyUncompressed: Buffer,
  keyId: Buffer,
  policyContractId: string
): xdr.ScVal {
  const externalPolicy = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("ExternalValidatorPolicy"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("policy_address"),
        val: Address.fromString(policyContractId).toScVal(),
      }),
    ]),
  ]);

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("key_id"),
        val: xdr.ScVal.scvBytes(keyId),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(publicKeyUncompressed),
      }),
    ]),
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Standard"),
      xdr.ScVal.scvVec([externalPolicy]),
    ]),
  ]);
}

function buildEd25519AdminSigner(publicKey: string): xdr.ScVal {
  const pubBytes = StrKey.decodeEd25519PublicKey(publicKey);
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Ed25519"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(Buffer.from(pubBytes)),
      }),
    ]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Admin")]),
  ]);
}

function buildPreSignedAuth(
  walletAddress: string,
  signerKp: Keypair,
  invocation: xdr.SorobanAuthorizedInvocation,
  expirationLedger: number
): xdr.SorobanAuthorizationEntry {
  const nonce = makeNonce();
  const networkIdHash = stellarHash(Buffer.from(NETWORK_PASSPHRASE, "utf-8"));

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: networkIdHash,
      nonce,
      signatureExpirationLedger: expirationLedger,
      invocation,
    })
  );
  const authHash = stellarHash(preimage.toXDR());
  const signature = signerKp.sign(authHash);

  const publicKeyBytes = StrKey.decodeEd25519PublicKey(signerKp.publicKey());
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Ed25519"),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyBytes)),
  ]);
  const signerProof = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Ed25519"),
    xdr.ScVal.scvBytes(signature),
  ]);
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

async function deployAndSetupWallet(
  p256Signer: SoftP256Signer
): Promise<string> {
  console.log("\n--- Phase 1a: Deploy Smart Wallet ---");

  const deployerKp = Keypair.fromSecret(DEPLOYER_SECRET);

  // Fund deployer via friendbot
  const fb = await fetch(`https://friendbot.stellar.org?addr=${deployerKp.publicKey()}`);
  console.log(fb.ok ? "  Deployer funded" : "  Deployer already funded");

  const account = await server.getAccount(deployerKp.publicKey());
  const saltBytes = crypto.randomBytes(32);
  const wasmHashBytes = Buffer.from(WASM_HASH, "hex");

  const adminSigner = buildEd25519AdminSigner(deployerKp.publicKey());
  const constructorArgs = xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([adminSigner]),
    xdr.ScVal.scvVec([]),
  ]);

  const deploymentArgs = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("constructor_args"),
      val: constructorArgs,
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("salt"),
      val: xdr.ScVal.scvBytes(saltBytes),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("wasm_hash"),
      val: xdr.ScVal.scvBytes(wasmHashBytes),
    }),
  ]);

  let tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: FACTORY_CONTRACT,
        function: "deploy_idempotent",
        args: [
          Address.fromString(deployerKp.publicKey()).toScVal(),
          deploymentArgs,
        ],
      })
    )
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim))
    throw new Error(`Deploy sim failed: ${(sim as any).error}`);

  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(deployerKp);

  const resp = await server.sendTransaction(tx);
  if (resp.status === "ERROR") throw new Error("Deploy submit failed");

  const status = await waitForTx(resp.hash);
  if (status.status !== "SUCCESS") throw new Error("Deploy tx failed");

  // Extract wallet address from return value
  let walletAddress: string | null = null;
  const statusAny = status as any;
  if (statusAny.returnValue?.switch().name === "scvAddress") {
    walletAddress = Address.fromScAddress(statusAny.returnValue.address()).toString();
  }
  if (!walletAddress) throw new Error("Could not extract wallet C-address");

  console.log(`  Wallet: ${walletAddress}`);

  // Phase 1b: Add Secp256r1 agent signer with policy
  console.log("\n--- Phase 1b: Add Secp256r1 Agent Signer ---");

  const { sequence: latestLedger } = await server.getLatestLedger();
  const expirationLedger = latestLedger + 1000;

  const signerArg = buildSecp256r1PolicySigner(
    p256Signer.getPublicKey(),
    p256Signer.getKeyId(),
    V2_POLICY
  );

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(walletAddress).toScAddress(),
          functionName: "add_signer",
          args: [signerArg],
        })
      ),
    subInvocations: [
      new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(V2_POLICY).toScAddress(),
              functionName: "on_add",
              args: [Address.fromString(walletAddress).toScVal()],
            })
          ),
        subInvocations: [],
      }),
    ],
  });

  const signedAuthEntry = buildPreSignedAuth(
    walletAddress,
    deployerKp,
    invocation,
    expirationLedger
  );

  const adminAccount = await server.getAccount(deployerKp.publicKey());
  const seqStr = adminAccount.sequenceNumber();

  const baseTx = new TransactionBuilder(
    new Account(deployerKp.publicKey(), seqStr),
    { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE }
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: walletAddress,
        function: "add_signer",
        args: [signerArg],
        auth: [signedAuthEntry],
      })
    )
    .setTimeout(300)
    .build();

  const addSim = await server.simulateTransaction(baseTx);
  if (!rpc.Api.isSimulationSuccess(addSim))
    throw new Error(`add_signer sim failed: ${(addSim as any).error}`);

  const freshTx = new TransactionBuilder(
    new Account(deployerKp.publicKey(), seqStr),
    { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE }
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: walletAddress,
        function: "add_signer",
        args: [signerArg],
        auth: [signedAuthEntry],
      })
    )
    .setTimeout(300)
    .build();

  const assembled = rpc.assembleTransaction(freshTx, addSim).build();
  (assembled.operations[0] as any).auth = [signedAuthEntry];

  const sd = assembled.toEnvelope().v1().tx().ext().sorobanData();
  const res = sd.resources();
  res.instructions(Math.ceil(res.instructions() * 1.25));

  assembled.sign(deployerKp);

  const addResp = await server.sendTransaction(assembled);
  if (addResp.status === "ERROR") throw new Error("add_signer submit failed");

  const addStatus = await waitForTx(addResp.hash);
  if (addStatus.status !== "SUCCESS") throw new Error("add_signer tx failed");

  console.log(`  Secp256r1 signer added (key_id: ${p256Signer.getKeyId().toString("hex").substring(0, 16)}...)`);
  console.log(`  Policy: ${V2_POLICY} ($50/day)`);

  // Phase 1c: Fund wallet with USDC
  console.log("\n--- Phase 1c: Fund Wallet with USDC ---");

  // Wait for add_signer tx to fully propagate
  await new Promise((r) => setTimeout(r, 3000));

  const funderAccount = await server.getAccount(deployerKp.publicKey());
  console.log(`  Funder seq: ${funderAccount.sequenceNumber()}`);
  const usdcContract = new Contract(USDC_SAC);

  let fundTx = new TransactionBuilder(funderAccount, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      usdcContract.call(
        "transfer",
        Address.fromString(deployerKp.publicKey()).toScVal(),
        Address.fromString(walletAddress).toScVal(),
        buildI128(10_000_000n) // 1 USDC
      )
    )
    .setTimeout(300)
    .build();

  const fundSim = await server.simulateTransaction(fundTx);
  if (rpc.Api.isSimulationRestore(fundSim)) {
    console.log("  Restoring ledger entries first...");
    const restoreTx = rpc.assembleTransaction(
      new TransactionBuilder(await server.getAccount(deployerKp.publicKey()), {
        fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE
      }).addOperation(Operation.restoreFootprint({})).setTimeout(300).build(),
      fundSim
    ).build();
    restoreTx.sign(deployerKp);
    const rr = await server.sendTransaction(restoreTx);
    if (rr.status !== "ERROR") await waitForTx(rr.hash);
    // Re-fetch account and re-sim
    const freshAcct = await server.getAccount(deployerKp.publicKey());
    fundTx = new TransactionBuilder(freshAcct, {
      fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE
    }).addOperation(
      usdcContract.call("transfer",
        Address.fromString(deployerKp.publicKey()).toScVal(),
        Address.fromString(walletAddress).toScVal(),
        buildI128(10_000_000n))
    ).setTimeout(300).build();
    const fundSim2 = await server.simulateTransaction(fundTx);
    if (!rpc.Api.isSimulationSuccess(fundSim2))
      throw new Error(`Fund re-sim failed: ${(fundSim2 as any).error}`);
    fundTx = rpc.assembleTransaction(fundTx, fundSim2).build();
  } else if (!rpc.Api.isSimulationSuccess(fundSim)) {
    throw new Error(`Fund sim failed: ${(fundSim as any).error}`);
  } else {
    fundTx = rpc.assembleTransaction(fundTx, fundSim).build();
  }
  fundTx.sign(deployerKp);

  const fundResp = await server.sendTransaction(fundTx);
  if (fundResp.status === "ERROR") {
    const errBody = (fundResp as any).errorResult || (fundResp as any).diagnosticEventsXdr || "no details";
    throw new Error(`Fund submit failed: ${JSON.stringify(errBody)}`);
  }

  const fundStatus = await waitForTx(fundResp.hash);
  if (fundStatus.status !== "SUCCESS") throw new Error("Fund tx failed");

  console.log("  Funded with 1 USDC");

  return walletAddress;
}

// ============================================================================
// Phase 2: Build P-256 Signed Payment Payload
// ============================================================================

async function buildP256PaymentPayload(
  walletAddress: string,
  signer: SoftP256Signer,
  payTo: string
): Promise<{
  paymentPayload: any;
  paymentRequirements: any;
  localSimOk: boolean;
}> {
  console.log("\n--- Phase 2: Build P-256 Signed Payment ---");
  console.log(`  Wallet:  ${walletAddress}`);
  console.log(`  Pay to:  ${payTo.substring(0, 16)}...`);
  console.log(`  Amount:  ${TRANSFER_AMOUNT} stroops ($${(Number(TRANSFER_AMOUNT) / 1e7).toFixed(4)})`);
  console.log(`  Signer:  Secp256r1 (SoftP256Signer)`);

  const { sequence: latestLedger } = await server.getLatestLedger();
  const expirationLedger = latestLedger + 50;

  const transferArgs = [
    Address.fromString(walletAddress).toScVal(),
    Address.fromString(payTo).toScVal(),
    buildI128(TRANSFER_AMOUNT),
  ];

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC_SAC).toScAddress(),
          functionName: "transfer",
          args: transferArgs,
        })
      ),
    subInvocations: [],
  });

  // Sign auth with SoftP256Signer via buildSmartWalletAuth
  console.log("  Signing auth with P-256 key...");
  const signedAuthEntry = await buildSmartWalletAuth(
    walletAddress,
    signer,
    invocation,
    expirationLedger,
    NETWORK_PASSPHRASE
  );

  // Inspect the auth entry
  const creds = signedAuthEntry.credentials().address();
  const sigProofs = creds.signature();
  console.log(`  Auth entry built:`);
  console.log(`    Credentials: sorobanCredentialsAddress (C-address)`);
  console.log(`    Expiration: ledger ${expirationLedger}`);

  // Check SignerKey format
  try {
    const outerVec = sigProofs.vec();
    if (outerVec && outerVec.length > 0) {
      const innerMap = outerVec[0].map();
      if (innerMap && innerMap.length > 0) {
        const keyVec = innerMap[0].key().vec();
        if (keyVec && keyVec.length >= 2) {
          console.log(`    SignerKey type: ${keyVec[0].sym()}`);
          console.log(`    Key ID: ${Buffer.from(keyVec[1].bytes()).toString("hex").substring(0, 16)}...`);
        }
        const proofVec = innerMap[0].val().vec();
        if (proofVec && proofVec.length >= 2) {
          console.log(`    SignerProof type: ${proofVec[0].sym()}`);
          const proofMap = proofVec[1].map();
          if (proofMap) {
            for (const entry of proofMap) {
              const fieldName = entry.key().sym();
              const fieldBytes = entry.val().bytes();
              console.log(`    ${fieldName}: ${fieldBytes.length} bytes`);
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.log(`    (Could not inspect auth: ${e.message})`);
  }

  // Build + simulate TX
  // Use deployer as source for testnet, facilitator for mainnet
  const sourceAccount = NETWORK === "testnet"
    ? Keypair.fromSecret(DEPLOYER_SECRET).publicKey()
    : "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT";

  const account = await server.getAccount(sourceAccount);
  const seqNum = account.sequenceNumber();

  const baseTx = new TransactionBuilder(
    new Account(sourceAccount, seqNum),
    { fee: "100", networkPassphrase: NETWORK_PASSPHRASE }
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: USDC_SAC,
        function: "transfer",
        args: transferArgs,
        auth: [signedAuthEntry],
      })
    )
    .setTimeout(300)
    .build();

  console.log("\n  Simulating...");
  const sim = await server.simulateTransaction(baseTx);
  let localSimOk = false;

  if (rpc.Api.isSimulationSuccess(sim)) {
    console.log(`  Simulation PASSED (CPU: ${sim.cost?.cpuInsns || "N/A"})`);
    console.log("  __check_auth accepted Secp256r1 SignerKey/SignerProof!");
    localSimOk = true;
  } else {
    const err = (sim as any).error || "unknown";
    console.log(`  Simulation FAILED: ${err}`);
  }

  // Assemble
  let unsignedTxXdr: string;
  if (localSimOk) {
    const freshTx = new TransactionBuilder(
      new Account(sourceAccount, seqNum),
      { fee: "100", networkPassphrase: NETWORK_PASSPHRASE }
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: USDC_SAC,
          function: "transfer",
          args: transferArgs,
          auth: [signedAuthEntry],
        })
      )
      .setTimeout(300)
      .build();

    const assembled = rpc.assembleTransaction(freshTx, sim).build();
    (assembled.operations[0] as any).auth = [signedAuthEntry];

    const sd = assembled.toEnvelope().v1().tx().ext().sorobanData();
    const resources = sd.resources();
    resources.instructions(Math.ceil(resources.instructions() * 1.25));

    unsignedTxXdr = assembled.toEnvelope().toXDR("base64");
  } else {
    unsignedTxXdr = baseTx.toEnvelope().toXDR("base64");
  }

  const caip2 = CAIP2[NETWORK];
  const paymentRequirements = {
    scheme: "exact",
    network: caip2,
    amount: TRANSFER_AMOUNT.toString(),
    payTo,
    maxTimeoutSeconds: 300,
    asset: USDC_SAC,
    extra: { areFeesSponsored: true },
  };

  const paymentPayload = {
    x402Version: 2,
    accepted: { ...paymentRequirements },
    payload: { transaction: unsignedTxXdr },
  };

  return { paymentPayload, paymentRequirements, localSimOk };
}

// ============================================================================
// Phase 3: OZ Facilitator
// ============================================================================

async function testOzFacilitator(
  paymentPayload: any,
  paymentRequirements: any,
  ozApiKey: string
): Promise<{ verified: boolean; settled: boolean; txHash?: string }> {
  const headers = {
    Authorization: `Bearer ${ozApiKey}`,
    "Content-Type": "application/json",
  };
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };

  // Verify
  console.log("\n--- Phase 3a: OZ /verify ---");
  const verifyResp = await fetch(`${OZ_BASE_URL}/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const verifyBody = await verifyResp.text();
  console.log(`  Status: ${verifyResp.status}`);
  console.log(`  Response: ${verifyBody.substring(0, 500)}`);

  let verified = false;
  try {
    const data = JSON.parse(verifyBody);
    verified = data.isValid === true;
    if (data.payer) console.log(`  Payer: ${data.payer}`);
  } catch {}

  if (!verified) {
    return { verified: false, settled: false };
  }

  // Settle
  console.log("\n--- Phase 3b: OZ /settle ---");
  const settleResp = await fetch(`${OZ_BASE_URL}/settle`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const settleBody = await settleResp.text();
  console.log(`  Status: ${settleResp.status}`);
  console.log(`  Response: ${settleBody.substring(0, 500)}`);

  let settled = false;
  let txHash: string | undefined;
  try {
    const data = JSON.parse(settleBody);
    settled = data.success === true;
    txHash = data.transaction;
  } catch {}

  return { verified, settled, txHash };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== P-256 (Secp256r1) Signer — E2E Test ===");
  console.log(`Network:  ${NETWORK}`);
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`USDC:     ${USDC_SAC}`);

  // Phase 0: Key
  const signer = await getOrCreateSigner();
  assert(signer.type === "Secp256r1", "Signer type is Secp256r1");
  assert(signer.getPublicKey().length === 65, "Public key is 65 bytes (uncompressed)");
  assert(signer.getPublicKey()[0] === 0x04, "Public key starts with 0x04");
  assert(signer.getKeyId().length === 32, "Key ID is 32 bytes (SHA256)");

  if (generateOnly) {
    console.log("\n  --generate mode: key created. Register it in the portal, then re-run without --generate.");
    console.log(`\n  For portal registration:`);
    console.log(`    Public key (base64): ${signer.getPublicKey().toString("base64")}`);
    console.log(`    Key ID (base64):     ${signer.getKeyId().toString("base64")}`);
    return;
  }

  // Phase 1: Wallet setup
  let walletAddress: string;

  if (walletArg) {
    walletAddress = walletArg.split("=")[1];
    console.log(`\n  Using existing wallet: ${walletAddress}`);
  } else if (NETWORK === "testnet") {
    walletAddress = await deployAndSetupWallet(signer);
  } else {
    console.error(
      "\nMainnet requires --wallet=CXXX. Register P-256 signer via portal first.\n" +
      "  1. Run: npx tsx examples/e2e-p256-signer.ts --generate\n" +
      "  2. Register the public key at agents.lumenbro.com\n" +
      "  3. Run: npx tsx examples/e2e-p256-signer.ts --wallet=CXXX --network=mainnet"
    );
    process.exit(1);
  }

  assert(walletAddress.startsWith("C"), "Wallet is C-address");

  // Check USDC balance
  console.log("\n--- Balance Check ---");
  const contract = new Contract(USDC_SAC);
  const sourceAcct = NETWORK === "testnet"
    ? Keypair.fromSecret(DEPLOYER_SECRET).publicKey()
    : "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT";

  const balAccount = await server.getAccount(sourceAcct);
  const balTx = new TransactionBuilder(balAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call("balance", Address.fromString(walletAddress).toScVal())
    )
    .setTimeout(30)
    .build();

  const balSim = await server.simulateTransaction(balTx);
  let balanceBefore = 0n;
  if (rpc.Api.isSimulationSuccess(balSim) && balSim.result?.retval) {
    const i128 = balSim.result.retval.i128();
    balanceBefore = (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
  }
  console.log(`  USDC: $${(Number(balanceBefore) / 1e7).toFixed(4)}`);
  assert(balanceBefore >= TRANSFER_AMOUNT, "Wallet has enough USDC");

  // Phase 2: Build P-256 signed payment
  // Pay to deployer on testnet, issuer on mainnet
  const payTo = NETWORK === "testnet"
    ? Keypair.fromSecret(DEPLOYER_SECRET).publicKey()
    : "GBQG67XV2VEKRYZBGT5LZSBOHVVVX7CLTCO7WCGQAA4R2SV2BCJW2VP2";

  const { paymentPayload, paymentRequirements, localSimOk } =
    await buildP256PaymentPayload(walletAddress, signer, payTo);

  assert(localSimOk, "Local simulation passed (Secp256r1 __check_auth accepted)");

  if (!localSimOk) {
    console.log("\nSimulation failed — P-256 auth was rejected by __check_auth.");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // Phase 3: OZ Facilitator
  console.log("\n  Getting OZ API key...");
  const ozApiKey = await getOzApiKey();
  console.log(`  OZ Key: ${ozApiKey.substring(0, 8)}...`);

  const { verified, settled, txHash } = await testOzFacilitator(
    paymentPayload,
    paymentRequirements,
    ozApiKey
  );

  assert(verified, "OZ /verify accepted Secp256r1 payment");
  assert(settled, "OZ /settle processed Secp256r1 payment");

  if (txHash) {
    const explorerBase = NETWORK === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
    console.log(`  TX: ${txHash}`);
    console.log(`  Explorer: ${explorerBase}/tx/${txHash}`);

    // Phase 4: Verify balance
    console.log("\n--- Phase 4: Post-Settlement Balance ---");
    await new Promise((r) => setTimeout(r, 6000));

    const balTx2 = new TransactionBuilder(
      new Account(sourceAcct, (await server.getAccount(sourceAcct)).sequenceNumber()),
      { fee: "100", networkPassphrase: NETWORK_PASSPHRASE }
    )
      .addOperation(
        contract.call("balance", Address.fromString(walletAddress).toScVal())
      )
      .setTimeout(30)
      .build();

    const balSim2 = await server.simulateTransaction(balTx2);
    let balanceAfter = 0n;
    if (rpc.Api.isSimulationSuccess(balSim2) && balSim2.result?.retval) {
      const i128 = balSim2.result.retval.i128();
      balanceAfter = (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
    }

    console.log(`  Before: $${(Number(balanceBefore) / 1e7).toFixed(4)}`);
    console.log(`  After:  $${(Number(balanceAfter) / 1e7).toFixed(4)}`);
    console.log(`  Cost:   $${((Number(balanceBefore) - Number(balanceAfter)) / 1e7).toFixed(4)}`);
    assert(balanceAfter < balanceBefore, "Balance decreased");
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log("\nCoverage:");
  console.log("  - SoftP256Signer key generation + encryption");
  console.log("  - Secp256r1 signer registration (key_id + public_key format)");
  console.log("  - P-256 signed auth (WebAuthn synthetic data + ECDSA)");
  console.log("  - __check_auth verification (Soroban verify_sig_ecdsa_secp256r1)");
  console.log("  - v2 payment payload (x402Version: 2)");
  console.log("  - OZ facilitator /verify + /settle");
  console.log(`\n  Wallet: ${walletAddress}`);
  console.log(`  Key ID: ${signer.getKeyId().toString("hex")}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  console.error(err.stack);
  process.exit(1);
});
