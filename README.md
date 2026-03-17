# lumenjoule-sdk

Give your AI agent a self-custodial wallet with on-chain spend limits. The SDK handles x402 payments automatically — your agent calls any x402-enabled API, the SDK detects the 402, signs a payment from the smart wallet, and retries. No API keys, no custodians, no seed phrases.

**Self-custodial by design.** The agent's signing key lives on your device (Secure Enclave, encrypted file, or Stellar keypair). The server never touches private keys — it only wraps transactions for gas sponsorship. Unlike MPC wallets (Privy, Crossmint, Turnkey), there are no key shards on someone else's server.

## Install

```bash
npm install lumenjoule-sdk
```

Create a wallet at [agents.lumenbro.com](https://agents.lumenbro.com) — passkey-secured, no seed phrases, deployed in under 2 minutes.

## Quick Start

```typescript
import { SmartWalletClient } from "lumenjoule-sdk";

const client = new SmartWalletClient({
  agentSecretKey: process.env.AGENT_SECRET,
  walletAddress: "CXXX...",
  network: "mainnet",
});

// Pay any x402-enabled endpoint automatically
const response = await client.chat({
  model: "deepseek-ai/DeepSeek-V3",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

## How It Works

```
Your Smart Wallet (C-address)
├── Holds USDC (pooled funds)
├── On-chain spend policy ($50 / $500 / $2,000 per day)
└── Multiple agent signers, each with independent limits

Agent calls x402 API
    → Server returns 402 Payment Required
    → SDK signs transfer auth with agent key
    → Facilitator settles payment on Stellar (5s finality)
    → Agent gets the response
```

One wallet, many agents, each capped by an on-chain daily limit. Like a corporate card program — one funding account, multiple cards with individual limits.

## Pluggable Signers

Three signer types, same smart wallet. Pick based on your platform:

### Ed25519 — Stellar Keypair (Any Platform)

```typescript
import { SmartWalletClient } from "lumenjoule-sdk";

const client = new SmartWalletClient({
  agentSecretKey: "SXXX...",    // Ed25519 secret key
  walletAddress: "CXXX...",
  network: "mainnet",
});
```

### Secp256r1 — Software P-256 (Any Platform)

Encrypted key file on disk. Same P-256 curve as passkeys and Secure Enclave — production-ready on Linux VPS, Windows, macOS.

```typescript
import { SmartWalletClient, SoftP256Signer } from "lumenjoule-sdk";

// First time: generate and save encrypted key
const signer = await SoftP256Signer.generate("my-password");
// Returns: ~/.lumenjoule/agent-key.enc

// After: load existing key
const signer = await SoftP256Signer.load("my-password");

const client = new SmartWalletClient({ signer, walletAddress: "CXXX..." });
```

### Secp256r1 — Secure Enclave (macOS)

Hardware-bound P-256 key via [keypo-signer](https://github.com/keypo-us/keypo-cli). Private key never leaves the chip.

```typescript
import { SmartWalletClient, KeypoSigner } from "lumenjoule-sdk";

const signer = new KeypoSigner({
  keyLabel: "my-agent-key",
  publicKey: Buffer.from("BASE64_PUBLIC_KEY", "base64"),
});

const client = new SmartWalletClient({ signer, walletAddress: "CXXX..." });
```

## Pay Any x402 Endpoint

The wallet isn't limited to one service. `payAndFetch()` works with any x402-compatible endpoint:

```typescript
// AI inference
const response = await client.chat({
  model: "deepseek-ai/DeepSeek-V3",
  messages: [{ role: "user", content: "Analyze this data" }],
});

// Any x402 API
const data = await client.payAndFetch("https://some-api.com/v1/data");

// Direct USDC transfer
const txHash = await client.transfer(USDC_CONTRACT, recipientAddress, 1_000_000n);
```

## On-Chain Spend Policies

Every agent signer is gated by an on-chain daily limit. Even if a key is compromised, damage is capped.

```typescript
const client = new SmartWalletClient({
  agentSecretKey: process.env.AGENT_SECRET,
  walletAddress: "CXXX...",
  policyAddress: "CBRGH27Z...", // Starter tier
});

const budget = await client.budgetStatus();
// { dailyLimitUsdc: 50, spentTodayUsdc: 3.20, remainingUsdc: 46.80 }
```

| Tier | Daily Limit | Contract |
|------|-------------|----------|
| Starter | $50/day | `CBRGH27ZFVFDIHYKC4K3CSLKXHQSR5CFG2PLPZ2M37NH4PYBOBTTQAEC` |
| Production | $500/day | `CCRIFGLMG3PT7R3V2IFSRNDNKR2Y2DLJAI5KXYBKNJPFCL2QC4MDIZNJ` |
| Enterprise | $2,000/day | `CCSPAXNEVBNA5QAEU2YEUTU56O5KOZM4C2O7ONQ6GFPSHEWV5OJJS5H2` |

Individual queries: `client.dailyLimit()`, `client.spentToday()`, `client.remaining()`.

## API Reference

### SmartWalletClient

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `walletAddress` | `string` | required | Smart wallet C-address |
| `agentSecretKey` | `string` | — | Ed25519 secret key (S...) |
| `signer` | `AgentSigner` | — | Pluggable signer (alternative to agentSecretKey) |
| `network` | `"testnet" \| "mainnet"` | `"mainnet"` | Stellar network |
| `computeUrl` | `string` | `compute.lumenbro.com` | Default x402 endpoint for chat() |
| `rpcUrl` | `string` | auto | Custom Soroban RPC URL |
| `preferredAsset` | `string` | USDC | Payment asset |
| `policyAddress` | `string` | — | Spend policy contract for budget queries |

### Methods

| Method | Description |
|--------|-------------|
| `chat(request)` | OpenAI-compatible chat completion with auto x402 payment |
| `payAndFetch(url, init?)` | Pay any x402 endpoint and return the response |
| `transfer(token, to, amount)` | Direct token transfer (Ed25519 only, agent pays gas) |
| `usdcBalance()` | USDC balance (7-decimal stroops) |
| `balance(token?)` | Any token balance (defaults to LumenJoule) |
| `gasBalance()` | XLM balance |
| `budgetStatus()` | Daily limit, spent today, remaining (requires policyAddress) |
| `dailyLimit()` | Policy daily limit in stroops |
| `spentToday()` | Amount spent today in stroops |
| `remaining()` | Remaining budget in stroops |

## x402 Protocol Helpers

Lower-level helpers for custom x402 integrations:

```typescript
import { parsePaymentRequirements, performX402Dance } from "lumenjoule-sdk";

// Full dance: request → 402 → build payment → retry
const paidResponse = await performX402Dance(url, init, buildPaymentFn);
```

## Why Self-Custody Matters

| Provider | Key Model | Self-Custodial? |
|----------|-----------|-----------------|
| **lumenjoule-sdk** | Device-local (SE, passkey, encrypted file) | Yes |
| Privy | MPC sharded (server holds share) | No |
| Crossmint | API key custodial | No |
| Turnkey | Infra-managed HSM | No |
| Coinbase AgentKit | CDP API key | No |

If your provider goes down or changes terms, your agent's wallet should still work. With self-custody, it does.

## Links

- [Agent Portal](https://agents.lumenbro.com) — Create wallets + register agent signers
- [npm](https://www.npmjs.com/package/lumenjoule-sdk)
- [GitHub](https://github.com/lumenbro/lumenjoule-sdk)
- [x402 Protocol](https://x402.org)
- [Stellar](https://stellar.org)

## License

MIT
