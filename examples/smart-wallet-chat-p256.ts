/**
 * Example: Smart wallet with P-256 (Secp256r1) agent key.
 *
 * Uses SoftP256Signer for cross-platform development/testing.
 * On macOS with Secure Enclave, use KeypoSigner instead.
 *
 * Setup (first time):
 *   PASSWORD=mypass npx tsx examples/smart-wallet-chat-p256.ts --generate
 *
 * Usage:
 *   PASSWORD=mypass WALLET_ADDRESS=CXXX npx tsx examples/smart-wallet-chat-p256.ts
 *
 * With KeypoSigner (macOS):
 *   WALLET_ADDRESS=CXXX KEYPO_LABEL=agent-bot KEYPO_PUBKEY=<hex65> npx tsx examples/smart-wallet-chat-p256.ts --keypo
 */

import { SmartWalletClient, SoftP256Signer, KeypoSigner } from "../src";

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const PASSWORD = process.env.PASSWORD;
const COMPUTE_URL = process.argv.find((a) => !a.startsWith("-")) || "https://compute.lumenbro.com";
const NETWORK = (process.env.NETWORK || "mainnet") as "testnet" | "mainnet";

async function main() {
  const args = process.argv.slice(2);

  // ─── Generate mode: create a new P-256 key ───────────────────
  if (args.includes("--generate")) {
    if (!PASSWORD) {
      console.error("Set PASSWORD env var to encrypt the key file");
      process.exit(1);
    }

    console.log("Generating P-256 agent key...");
    const signer = await SoftP256Signer.generate(PASSWORD);
    console.log(`Public key (hex): ${signer.getPublicKey().toString("hex")}`);
    console.log(`Key ID (hex):     ${signer.getKeyId().toString("hex")}`);
    console.log(`Saved to:         ~/.lumenjoule/agent-key.enc`);
    console.log(
      "\nRegister this public key on agents.lumenbro.com, then run:"
    );
    console.log(
      "  PASSWORD=mypass WALLET_ADDRESS=C... npx tsx examples/smart-wallet-chat-p256.ts"
    );
    return;
  }

  if (!WALLET_ADDRESS) {
    console.error("Set WALLET_ADDRESS env var (C-address of your smart wallet)");
    process.exit(1);
  }

  // ─── Keypo mode: Secure Enclave (macOS only) ────────────────
  let client: SmartWalletClient;

  if (args.includes("--keypo")) {
    const keyLabel = process.env.KEYPO_LABEL;
    const pubKeyHex = process.env.KEYPO_PUBKEY;

    if (!keyLabel || !pubKeyHex) {
      console.error("Set KEYPO_LABEL and KEYPO_PUBKEY env vars for SE signing");
      process.exit(1);
    }

    const signer = new KeypoSigner({
      keyLabel,
      publicKey: Buffer.from(pubKeyHex, "hex"),
    });

    client = new SmartWalletClient({
      signer,
      walletAddress: WALLET_ADDRESS,
      computeUrl: COMPUTE_URL,
      network: NETWORK,
    });

    console.log("=== Smart Wallet Chat (KeypoSigner / Secure Enclave) ===\n");
    console.log(`Key label: ${keyLabel}`);
  } else {
    // ─── SoftP256 mode: software key (cross-platform) ──────────
    if (!PASSWORD) {
      console.error("Set PASSWORD env var to decrypt the key file");
      process.exit(1);
    }

    const signer = await SoftP256Signer.load(PASSWORD);

    client = new SmartWalletClient({
      signer,
      walletAddress: WALLET_ADDRESS,
      computeUrl: COMPUTE_URL,
      network: NETWORK,
    });

    console.log("=== Smart Wallet Chat (SoftP256Signer) ===\n");
    console.log(`Key ID:  ${signer.getKeyId().toString("hex").slice(0, 16)}...`);
  }

  console.log(`Wallet:  ${client.address}`);
  console.log(`Signer:  ${client.signerType}`);
  console.log(`Server:  ${COMPUTE_URL}`);
  console.log(`Network: ${NETWORK}\n`);

  // Check wallet balance
  console.log("1. Checking wallet balance...");
  try {
    const bal = await client.balance();
    console.log(`   LumenJoule balance: ${Number(bal) / 10_000_000} LJOULE\n`);
  } catch (err: any) {
    console.log(`   Balance check failed: ${err.message}\n`);
  }

  // Make an inference request
  console.log("2. Sending chat request (auto-pays from smart wallet)...\n");
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
