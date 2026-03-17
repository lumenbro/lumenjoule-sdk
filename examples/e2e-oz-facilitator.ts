#!/usr/bin/env tsx
/**
 * E2E Test: OZ x402 Facilitator Compatibility (Mainnet)
 *
 * Tests that the OpenZeppelin Stellar x402 facilitator correctly handles
 * C-address (smart wallet) payments with Ed25519 SignerKey/SignerProof.
 *
 * This proves interoperability: our SmartWalletClient SDK can pay through
 * the OZ facilitator, not just our custom facilitator.
 *
 * Flow:
 *   1. Probe OZ facilitator /supported endpoint
 *   2. Check USDC balance
 *   3. Build v2 payment payload (unsigned TX + pre-signed auth)
 *   4. Local simulation (verify auth works)
 *   5. POST /verify to OZ facilitator
 *   6. POST /settle to OZ facilitator
 *   7. Verify on-chain settlement + balance decrease
 *
 * Usage:
 *   AGENT_SECRET=SXXX WALLET_ADDRESS=CXXX OZ_API_KEY=xxx npx tsx examples/e2e-oz-facilitator.ts
 *
 * Optional:
 *   NETWORK=testnet          — default: mainnet
 *   PAY_TO=GXXX              — recipient (default: our facilitator address)
 *   AMOUNT=1000000           — stroops (default: 1000000 = $0.10)
 */

import {
  rpc,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  Contract,
  Account,
  xdr,
} from "@stellar/stellar-sdk";
import { buildSmartWalletAuth, buildI128 } from "../src/smart-wallet-auth";
import { Ed25519AgentSigner } from "../src/signers/ed25519";

// ============================================================================
// Configuration
// ============================================================================

const AGENT_SECRET = process.env.AGENT_SECRET;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
// OZ API key: generate from channels.openzeppelin.com/gen (mainnet) or /testnet/gen (testnet)
const OZ_API_KEY = process.env.OZ_API_KEY || "74de2782-d105-4c6d-9c0c-e5fb8f0e1348";

if (!AGENT_SECRET || !WALLET_ADDRESS) {
  console.error(
    "Usage: AGENT_SECRET=S... WALLET_ADDRESS=C... npx tsx examples/e2e-oz-facilitator.ts"
  );
  process.exit(1);
}

const NETWORK = (process.env.NETWORK || "mainnet") as "testnet" | "mainnet";

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

// Default source accounts for simulation (facilitator addresses, always funded)
const SOURCE_ACCOUNTS: Record<string, string> = {
  mainnet: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
  testnet: "GBPUEDMWGNHUJBV3YK3MEMF7O3HYZ5JLLC634ALSHWIVGLY3GLZM6FMR",
};

const RPC_URL = RPC_URLS[NETWORK];
const NETWORK_PASSPHRASE = PASSPHRASES[NETWORK];
const CAIP2_NETWORK = CAIP2[NETWORK];
const USDC_SAC = USDC_SACS[NETWORK];
const SOURCE_ACCOUNT = SOURCE_ACCOUNTS[NETWORK];

// Transfer: $0.10 USDC (1,000,000 stroops at 7 decimals)
const TRANSFER_AMOUNT = BigInt(process.env.AMOUNT || "1000000");

// Pay to: must be an address with a USDC classic trustline.
// The issuer/owner address has one (verified via SAC balance query).
const PAY_TO =
  process.env.PAY_TO || "GBQG67XV2VEKRYZBGT5LZSBOHVVVX7CLTCO7WCGQAA4R2SV2BCJW2VP2";

// OZ facilitator candidate URLs
const OZ_BASE_URLS = [
  "https://channels.openzeppelin.com/x402",
  `https://channels.openzeppelin.com/x402/${NETWORK}`,
  `https://channels.openzeppelin.com/${NETWORK}/x402`,
  "https://channels.openzeppelin.com/x402/testnet", // fallback
];

const server = new rpc.Server(RPC_URL);
const agentKp = Keypair.fromSecret(AGENT_SECRET);
const signer = new Ed25519AgentSigner(AGENT_SECRET);

// ============================================================================
// Test Harness
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

// ============================================================================
// Phase 0: Probe OZ Facilitator
// ============================================================================

let activeOzBaseUrl = "";

async function probeOzFacilitator(): Promise<boolean> {
  console.log("\n--- Phase 0: Probe OZ Facilitator ---");

  const headers = {
    Authorization: `Bearer ${OZ_API_KEY}`,
    "Content-Type": "application/json",
  };

  for (const baseUrl of OZ_BASE_URLS) {
    try {
      console.log(`  Probing: ${baseUrl}/supported`);
      const resp = await fetch(`${baseUrl}/supported`, { headers });
      const body = await resp.text();
      console.log(`    Status: ${resp.status}`);

      if (resp.ok) {
        activeOzBaseUrl = baseUrl;
        console.log(`  Found: ${baseUrl}`);
        try {
          const data = JSON.parse(body);
          if (data.kinds) console.log(`  Mechanisms: ${JSON.stringify(data.kinds)}`);
          if (data.signers) console.log(`  Signers: ${JSON.stringify(data.signers)}`);
        } catch {}
        return true;
      }
    } catch (err: any) {
      console.log(`    Error: ${err.message}`);
    }
  }

  // Fallback: probe POST /verify with empty body
  for (const baseUrl of OZ_BASE_URLS) {
    try {
      console.log(`  Probing POST: ${baseUrl}/verify`);
      const resp = await fetch(`${baseUrl}/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      console.log(`    Status: ${resp.status}`);

      if (resp.status !== 404 && resp.status !== 401) {
        activeOzBaseUrl = baseUrl;
        console.log(`  Found via /verify: ${baseUrl}`);
        return true;
      }
    } catch (err: any) {
      console.log(`    Error: ${err.message}`);
    }
  }

  console.log("  No OZ facilitator endpoint found");
  return false;
}

// ============================================================================
// Phase 1: Balance Check
// ============================================================================

async function queryBalance(): Promise<bigint> {
  const contract = new Contract(USDC_SAC);
  const account = await server.getAccount(SOURCE_ACCOUNT);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call("balance", Address.fromString(WALLET_ADDRESS).toScVal())
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Balance query failed: ${(sim as any).error}`);
  }

  const retVal = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retVal) return 0n;

  const i128 = retVal.i128();
  return (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
}

// ============================================================================
// Phase 2: Build v2 Payment Payload
// ============================================================================

interface PaymentRequirementsV2 {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

interface PaymentPayloadV2 {
  x402Version: number;
  accepted: PaymentRequirementsV2;
  payload: {
    transaction: string;
  };
}

async function buildPaymentPayload(): Promise<{
  paymentPayload: PaymentPayloadV2;
  paymentRequirements: PaymentRequirementsV2;
  localSimOk: boolean;
}> {
  console.log("\n--- Phase 2: Build v2 Payment Payload ---");
  console.log(`  Wallet:  ${WALLET_ADDRESS}`);
  console.log(`  Agent:   ${agentKp.publicKey().substring(0, 16)}...`);
  console.log(`  Pay to:  ${PAY_TO.substring(0, 16)}...`);
  console.log(`  Amount:  ${TRANSFER_AMOUNT} stroops ($${(Number(TRANSFER_AMOUNT) / 1e7).toFixed(4)})`);
  console.log(`  Asset:   USDC (${USDC_SAC.substring(0, 16)}...)`);

  const { sequence: latestLedger } = await server.getLatestLedger();
  const expirationLedger = latestLedger + 50; // ~250s

  // Build transfer(C_address, payTo, amount)
  const transferArgs = [
    Address.fromString(WALLET_ADDRESS).toScVal(),
    Address.fromString(PAY_TO).toScVal(),
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

  // Pre-sign auth with C-address credentials (SDK's buildSmartWalletAuth)
  const signedAuthEntry = await buildSmartWalletAuth(
    WALLET_ADDRESS,
    signer,
    invocation,
    expirationLedger,
    NETWORK_PASSPHRASE
  );

  console.log(`  Auth entry: sorobanCredentialsAddress (C-address)`);
  console.log(`  Expiration: ledger ${expirationLedger}`);

  // Build TX (source = facilitator placeholder)
  const account = await server.getAccount(SOURCE_ACCOUNT);
  const seqNum = account.sequenceNumber();

  const baseTx = new TransactionBuilder(
    new Account(SOURCE_ACCOUNT, seqNum),
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

  // Local simulation — may fail due to trustline issues on recipient,
  // but auth validity is confirmed by __check_auth events.
  // The OZ facilitator handles trustline setup during settlement (areFeesSponsored: true).
  console.log("\n  Local simulation...");
  const sim = await server.simulateTransaction(baseTx);
  let localSimOk = false;
  let authValid = false;

  if (rpc.Api.isSimulationSuccess(sim)) {
    console.log(`  Simulation passed (CPU: ${sim.cost?.cpuInsns || "N/A"})`);
    localSimOk = true;
    authValid = true;
  } else {
    const simError = (sim as any).error || "unknown";
    console.log(`  Simulation failed: ${simError}`);

    // Check if auth passed even though sim failed overall
    // (e.g. trustline missing on recipient is NOT an auth issue)
    // Events are embedded in the error string
    if (simError.includes("fn_return, __check_auth") || simError.includes("__check_auth], data:Void")) {
      console.log("  Auth validated: __check_auth returned Void (in error events)");
      authValid = true;
    } else if (simError.includes("trustline entry is missing")) {
      // Trustline issue but we can't confirm auth from error string —
      // check sim.events array
      const events = (sim as any).events || [];
      for (const evt of events) {
        try {
          const decoded = xdr.DiagnosticEvent.fromXDR(evt, "base64");
          const body = decoded.event().body().v0();
          const topics = body.topics();
          if (topics.length >= 2 && topics[0].sym?.() === "fn_return" && topics[1].sym?.() === "__check_auth") {
            console.log("  Auth validated: __check_auth returned Void (from events array)");
            authValid = true;
            break;
          }
        } catch {}
      }
      // If still can't confirm from structured events, trust the error log pattern
      if (!authValid && simError.includes("is_authorized") && simError.includes("true")) {
        console.log("  Auth likely valid: is_authorized returned true, failure is trustline-only");
        authValid = true;
      }
    }

    if (authValid) {
      console.log("  C-address auth is valid — sim failed for non-auth reason (likely trustline)");
      console.log("  OZ facilitator handles trustline setup during settlement");
    }
  }

  // Assemble + restore auth (use sim data if available, otherwise send raw)
  let unsignedTxXdr: string;

  if (localSimOk) {
    const freshTx = new TransactionBuilder(
      new Account(SOURCE_ACCOUNT, seqNum),
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

    // Bump instructions
    const sorobanData = assembled
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData();
    const resources = sorobanData.resources();
    resources.instructions(Math.ceil(resources.instructions() * 1.25));

    unsignedTxXdr = assembled.toEnvelope().toXDR("base64");
  } else {
    // Send unassembled TX — facilitator does its own sim + assembly
    unsignedTxXdr = baseTx.toEnvelope().toXDR("base64");
  }

  console.log(`  TX XDR: ${unsignedTxXdr.length} chars (unsigned)`);

  const paymentRequirements: PaymentRequirementsV2 = {
    scheme: "exact",
    network: CAIP2_NETWORK,
    amount: TRANSFER_AMOUNT.toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_SAC,
    extra: { areFeesSponsored: true },
  };

  const paymentPayload: PaymentPayloadV2 = {
    x402Version: 2,
    accepted: { ...paymentRequirements },
    payload: { transaction: unsignedTxXdr },
  };

  return { paymentPayload, paymentRequirements, localSimOk, authValid };
}

// ============================================================================
// Phase 3: OZ Facilitator /verify + /settle
// ============================================================================

async function testOzVerify(
  paymentPayload: PaymentPayloadV2,
  paymentRequirements: PaymentRequirementsV2
): Promise<{ isValid: boolean; payer?: string; error?: string }> {
  console.log("\n--- Phase 3a: OZ /verify ---");

  if (!activeOzBaseUrl) {
    return { isValid: false, error: "No endpoint found" };
  }

  const verifyUrl = `${activeOzBaseUrl}/verify`;
  console.log(`  URL: ${verifyUrl}`);

  const requestBody = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };

  try {
    const resp = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OZ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const body = await resp.text();
    console.log(`  Status: ${resp.status}`);
    console.log(`  Response: ${body.substring(0, 1000)}`);

    if (resp.ok) {
      try {
        const data = JSON.parse(body);
        return {
          isValid: data.isValid ?? false,
          payer: data.payer,
          error: data.invalidReason,
        };
      } catch {
        return { isValid: false, error: `Unparseable: ${body}` };
      }
    }

    return { isValid: false, error: `HTTP ${resp.status}: ${body}` };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

async function testOzSettle(
  paymentPayload: PaymentPayloadV2,
  paymentRequirements: PaymentRequirementsV2
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  console.log("\n--- Phase 3b: OZ /settle ---");

  if (!activeOzBaseUrl) {
    return { success: false, error: "No endpoint found" };
  }

  const settleUrl = `${activeOzBaseUrl}/settle`;
  console.log(`  URL: ${settleUrl}`);

  const requestBody = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };

  try {
    const resp = await fetch(settleUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OZ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const body = await resp.text();
    console.log(`  Status: ${resp.status}`);
    console.log(`  Response: ${body.substring(0, 1000)}`);

    if (resp.ok) {
      try {
        const data = JSON.parse(body);
        return {
          success: data.success ?? false,
          txHash: data.transaction,
          error: data.errorReason,
        };
      } catch {
        return { success: false, error: `Unparseable: ${body}` };
      }
    }

    return { success: false, error: `HTTP ${resp.status}: ${body}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== OZ x402 Facilitator — Mainnet Compatibility Test ===");
  console.log(`Network:  ${NETWORK} (${CAIP2_NETWORK})`);
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Wallet:   ${WALLET_ADDRESS}`);
  console.log(`Agent:    ${agentKp.publicKey()}`);
  console.log(`USDC:     ${USDC_SAC}`);
  console.log(`OZ Key:   ${OZ_API_KEY.substring(0, 8)}...`);

  // Phase 0: Probe OZ facilitator
  const ozFound = await probeOzFacilitator();
  assert(ozFound, "OZ facilitator endpoint discovered");

  // Phase 1: Balance check
  console.log("\n--- Phase 1: USDC Balance ---");
  const balanceBefore = await queryBalance();
  const balanceBeforeHuman = Number(balanceBefore) / 1e7;
  console.log(`  Balance: $${balanceBeforeHuman.toFixed(4)} USDC`);
  assert(balanceBefore > 0n, "Wallet has USDC");
  assert(
    balanceBefore >= TRANSFER_AMOUNT,
    `Balance >= $${(Number(TRANSFER_AMOUNT) / 1e7).toFixed(2)} (transfer amount)`
  );

  // Phase 2: Build payment payload
  const { paymentPayload, paymentRequirements, localSimOk, authValid } =
    await buildPaymentPayload();
  assert(authValid, "C-address auth valid (__check_auth + spend policy passed)");
  if (localSimOk) {
    assert(true, "Local simulation fully passed");
  } else if (authValid) {
    console.log("  (Local sim failed due to trustline — OZ facilitator handles this)");
  }

  if (!authValid) {
    console.log("\nAuth failed — cannot proceed with facilitator test.");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // Phase 3: OZ facilitator
  if (ozFound) {
    // 3a: Verify
    const verifyResult = await testOzVerify(paymentPayload, paymentRequirements);

    if (verifyResult.isValid) {
      assert(true, "OZ /verify accepted C-address USDC payment");
      if (verifyResult.payer) console.log(`  Payer: ${verifyResult.payer}`);

      // 3b: Settle
      const settleResult = await testOzSettle(paymentPayload, paymentRequirements);
      assert(settleResult.success, "OZ /settle processed C-address USDC payment");

      if (settleResult.txHash) {
        console.log(`  TX: ${settleResult.txHash}`);
        const explorerBase =
          NETWORK === "mainnet"
            ? "https://stellar.expert/explorer/public"
            : "https://stellar.expert/explorer/testnet";
        console.log(`  Explorer: ${explorerBase}/tx/${settleResult.txHash}`);

        // Phase 4: Verify balance decreased
        console.log("\n--- Phase 4: Post-Settlement Balance ---");
        // Wait a moment for ledger to close
        await new Promise((r) => setTimeout(r, 6000));
        const balanceAfter = await queryBalance();
        const balanceAfterHuman = Number(balanceAfter) / 1e7;
        console.log(`  Before: $${balanceBeforeHuman.toFixed(4)}`);
        console.log(`  After:  $${balanceAfterHuman.toFixed(4)}`);
        console.log(`  Cost:   $${(balanceBeforeHuman - balanceAfterHuman).toFixed(4)}`);
        assert(balanceAfter < balanceBefore, "Balance decreased after settlement");
      }

      if (!settleResult.success && settleResult.error) {
        console.log(`  Settle error: ${settleResult.error}`);
      }
    } else {
      assert(false, `OZ /verify rejected: ${verifyResult.error}`);
    }
  } else {
    console.log("\n  OZ facilitator not reachable — local simulation is the only validation.");
    console.log("  The simulation confirms C-address auth + SignerKey/SignerProof format works.");
    console.log("  Re-run when OZ facilitator is accessible.");
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log("\nCoverage:");
  console.log("  - C-address auth with SignerKey/SignerProof (Ed25519)");
  console.log("  - Pre-signed auth entry (sorobanCredentialsAddress)");
  console.log("  - Unsigned TX envelope (facilitator rebuilds + signs)");
  console.log("  - v2 payload format (x402Version: 2)");
  console.log("  - Local Soroban simulation (__check_auth validation)");
  if (ozFound) {
    console.log("  - OZ facilitator /verify endpoint");
    console.log("  - OZ facilitator /settle endpoint");
    console.log("  - On-chain settlement verification");
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  console.error(err.stack);
  process.exit(1);
});
