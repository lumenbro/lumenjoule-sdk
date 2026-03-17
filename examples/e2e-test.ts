/**
 * E2E Test: Portal registration → SDK chat via x402
 *
 * Prerequisites (one-time manual setup):
 *   1. Register wallet + Ed25519 agent at agents.lumenbro.com
 *   2. Fund C-address with USDC (transfer from any funded G-address)
 *
 * Usage:
 *   AGENT_SECRET=SXXX WALLET_ADDRESS=CXXX npx tsx examples/e2e-test.ts
 *
 * Optional:
 *   POLICY_ADDRESS=CXXX  — verify spend tracking
 *   NETWORK=testnet       — default: mainnet
 */

import { SmartWalletClient } from "../src";

const AGENT_SECRET = process.env.AGENT_SECRET;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

if (!AGENT_SECRET || !WALLET_ADDRESS) {
  console.error("Usage: AGENT_SECRET=S... WALLET_ADDRESS=C... npx tsx examples/e2e-test.ts");
  process.exit(1);
}

const NETWORK = (process.env.NETWORK || "mainnet") as "testnet" | "mainnet";
const POLICY_ADDRESS = process.env.POLICY_ADDRESS;

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

async function main() {
  console.log("=== E2E Test: SmartWalletClient → x402 → Inference ===\n");

  const client = new SmartWalletClient({
    agentSecretKey: AGENT_SECRET,
    walletAddress: WALLET_ADDRESS,
    network: NETWORK,
    policyAddress: POLICY_ADDRESS,
  });

  console.log(`Wallet:  ${client.address}`);
  console.log(`Agent:   ${client.agentPublicKey}`);
  console.log(`Network: ${NETWORK}\n`);

  // 1. Check USDC balance
  console.log("1. USDC balance check");
  const usdcBefore = await client.usdcBalance();
  const usdcBeforeHuman = Number(usdcBefore) / 1e7;
  console.log(`   Balance: $${usdcBeforeHuman.toFixed(4)} USDC`);
  assert(usdcBefore > 0n, "Wallet has USDC balance");
  assert(usdcBefore >= 1_000_000n, "Balance >= $0.10 (min payment)");

  // 2. Check spend budget (if policy configured)
  if (POLICY_ADDRESS) {
    console.log("\n2. Spend policy check");
    const budget = await client.budgetStatus();
    console.log(`   Daily limit: $${budget.dailyLimitUsdc.toFixed(2)}`);
    console.log(`   Spent today: $${budget.spentTodayUsdc.toFixed(2)}`);
    console.log(`   Remaining:   $${budget.remainingUsdc.toFixed(2)}`);
    assert(budget.dailyLimitUsdc > 0, "Daily limit is set");
    assert(budget.remainingUsdc > 0, "Has remaining budget");
  }

  // 3. Chat request (x402 payment)
  const step = POLICY_ADDRESS ? "3" : "2";
  console.log(`\n${step}. Chat request via x402`);
  const response = await client.chat({
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [
      { role: "user", content: "Reply with exactly: E2E_OK" },
    ],
    max_tokens: 10,
  });

  assert(!!response.choices?.[0]?.message?.content, "Response has content");
  assert(!!response._payment, "Response has payment metadata");
  assert(!!response._payment?.transaction, "Payment has TX hash");
  assert(response._payment?.payer === WALLET_ADDRESS, "Payer is wallet C-address");

  console.log(`\n   Model:   ${response.model}`);
  console.log(`   Content: ${response.choices[0].message.content}`);
  console.log(`   TX:      ${response._payment.transaction}`);
  console.log(`   Cost:    ${response._payment.amountPaid}`);
  console.log(`   Asset:   ${response._payment.asset}`);

  if (response._payment.transaction) {
    console.log(`   Explorer: https://stellar.expert/explorer/public/tx/${response._payment.transaction}`);
  }

  // 4. Verify balance decreased
  const nextStep = POLICY_ADDRESS ? "4" : "3";
  console.log(`\n${nextStep}. Post-payment balance check`);
  const usdcAfter = await client.usdcBalance();
  const usdcAfterHuman = Number(usdcAfter) / 1e7;
  console.log(`   Before: $${usdcBeforeHuman.toFixed(4)}`);
  console.log(`   After:  $${usdcAfterHuman.toFixed(4)}`);
  console.log(`   Cost:   $${(usdcBeforeHuman - usdcAfterHuman).toFixed(4)}`);
  assert(usdcAfter < usdcBefore, "Balance decreased after payment");

  // 5. Verify spend tracking updated (if policy)
  if (POLICY_ADDRESS) {
    console.log("\n5. Post-payment spend tracking");
    const budgetAfter = await client.budgetStatus();
    console.log(`   Spent today: $${budgetAfter.spentTodayUsdc.toFixed(4)}`);
    console.log(`   Remaining:   $${budgetAfter.remainingUsdc.toFixed(4)}`);
    assert(budgetAfter.spentTodayUsdc > 0, "Spend tracker recorded payment");
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
