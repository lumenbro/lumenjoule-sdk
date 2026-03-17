/**
 * Example: Smart wallet agent uses x402 to pay for AI inference.
 *
 * The smart wallet (C-address) is the payer. The agent keypair signs
 * auth entries using SignerKey/SignerProof format. The facilitator
 * rebuilds and submits the TX.
 *
 * Usage:
 *   AGENT_SECRET=SXXX WALLET_ADDRESS=CXXX npx tsx examples/smart-wallet-chat.ts [compute-url]
 *
 * With spend policy tracking:
 *   AGENT_SECRET=SXXX WALLET_ADDRESS=CXXX POLICY_ADDRESS=CXXX npx tsx examples/smart-wallet-chat.ts
 */

import { SmartWalletClient } from "../src";

const AGENT_SECRET = process.env.AGENT_SECRET;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

if (!AGENT_SECRET || !WALLET_ADDRESS) {
  console.error("Set AGENT_SECRET and WALLET_ADDRESS env vars");
  console.error("  AGENT_SECRET:   Ed25519 secret key (S...)");
  console.error("  WALLET_ADDRESS: Smart wallet C-address (C...)");
  process.exit(1);
}

const COMPUTE_URL = process.argv[2] || "https://compute.lumenbro.com";
const NETWORK = (process.env.NETWORK || "mainnet") as "testnet" | "mainnet";
const POLICY_ADDRESS = process.env.POLICY_ADDRESS;

async function main() {
  console.log("=== Smart Wallet Chat Example ===\n");

  const client = new SmartWalletClient({
    agentSecretKey: AGENT_SECRET,
    walletAddress: WALLET_ADDRESS,
    computeUrl: COMPUTE_URL,
    network: NETWORK,
    policyAddress: POLICY_ADDRESS,
  });

  console.log(`Wallet:  ${client.address}`);
  console.log(`Agent:   ${client.agentPublicKey}`);
  console.log(`Server:  ${COMPUTE_URL}`);
  console.log(`Network: ${NETWORK}\n`);

  // Check wallet balances
  console.log("1. Checking wallet balances...");
  try {
    const [ljoule, usdc] = await Promise.all([
      client.balance(),
      client.usdcBalance(),
    ]);
    console.log(`   LumenJoule: ${Number(ljoule) / 1e7} LJOULE`);
    console.log(`   USDC:       ${Number(usdc) / 1e7} USDC`);
  } catch (err: any) {
    console.log(`   Balance check failed: ${err.message}`);
  }

  // Check spend budget (if policy configured)
  if (POLICY_ADDRESS) {
    console.log("\n2. Checking spend budget...");
    try {
      const budget = await client.budgetStatus();
      console.log(`   Daily limit: $${budget.dailyLimitUsdc.toFixed(2)}`);
      console.log(`   Spent today: $${budget.spentTodayUsdc.toFixed(2)}`);
      console.log(`   Remaining:   $${budget.remainingUsdc.toFixed(2)}`);
    } catch (err: any) {
      console.log(`   Budget check failed: ${err.message}`);
    }
  }
  console.log();

  // Make an inference request
  const step = POLICY_ADDRESS ? "3" : "2";
  console.log(`${step}. Sending chat request (auto-pays from smart wallet)...\n`);
  const response = await client.chat({
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [
      {
        role: "system",
        content: "You are a concise technical writer.",
      },
      {
        role: "user",
        content:
          "Explain how x402 HTTP payment protocol works for AI agents in 3 sentences.",
      },
    ],
    max_tokens: 200,
  });

  console.log("--- Response ---");
  console.log(response.choices[0].message.content);
  console.log();
  console.log("--- Payment ---");
  console.log(`TX:      ${response._payment.transaction}`);
  console.log(`Payer:   ${response._payment.payer}`);
  console.log(`Asset:   ${response._payment.asset}`);
  console.log(`Cost:    ${response._payment.amountPaid}`);
  console.log(`Network: ${response._payment.network}`);

  if (response._payment.transaction) {
    console.log(
      `\nExplorer: https://stellar.expert/explorer/public/tx/${response._payment.transaction}`
    );
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
