/**
 * Example: Agent uses LumenJoule SDK to pay for AI inference.
 *
 * Usage:
 *   AGENT_SECRET=SXXX... npx tsx examples/chat.ts [compute-url]
 *
 * Defaults to https://compute.lumenbro.com
 */

import { LumenJouleClient } from "../src";

const AGENT_SECRET = process.env.AGENT_SECRET;
if (!AGENT_SECRET) {
  console.error("Set AGENT_SECRET env var (stellar keys show test-agent)");
  process.exit(1);
}

const COMPUTE_URL = process.argv[2] || "https://compute.lumenbro.com";

async function main() {
  console.log("=== LumenJoule SDK Chat Example ===\n");

  const client = new LumenJouleClient({
    secretKey: AGENT_SECRET,
    computeUrl: COMPUTE_URL,
    network: "testnet",
  });

  console.log(`Agent:   ${client.publicKey}`);
  console.log(`Server:  ${COMPUTE_URL}\n`);

  // Check available models
  console.log("1. Fetching available models...");
  const modelsData = await client.models();
  for (const model of modelsData.models) {
    console.log(`   ${model.id} — ${model.pricing.jouleAmountHuman}/query`);
  }
  console.log();

  // Make an inference request (automatically pays LumenJoule)
  console.log("2. Sending chat request (auto-pays LumenJoule)...\n");
  const response = await client.chat({
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [
      { role: "system", content: "You are a concise technical writer." },
      { role: "user", content: "Explain how x402 HTTP payment protocol works for AI agents in 3 sentences." },
    ],
    max_tokens: 200,
  });

  console.log("--- Response ---");
  console.log(response.choices[0].message.content);
  console.log();
  console.log("--- Payment ---");
  console.log(`TX:     ${response._payment.transaction}`);
  console.log(`Payer:  ${response._payment.payer}`);
  console.log(`Cost:   ${response._payment.ljoulesPaid}`);
  console.log(`Network: ${response._payment.network}`);

  if (response._payment.transaction) {
    console.log(
      `\nExplorer: https://stellar.expert/explorer/testnet/tx/${response._payment.transaction}`
    );
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
