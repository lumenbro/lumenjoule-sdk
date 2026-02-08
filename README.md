# joule-sdk

Pay for AI inference with JOULE tokens on Stellar. Your agent sends a prompt, the SDK handles payment automatically via the [x402](https://www.x402.org/) HTTP payment protocol.

```
Agent sends prompt → gets 402 → signs JOULE transfer → retries with payment → gets inference
```

One function call. No API keys. No subscriptions. Just tokens and compute.

## Quick Start

```bash
npm install joule-sdk
```

```typescript
import { JouleClient } from "joule-sdk";

const client = new JouleClient({
  secretKey: "SXXX...",  // Agent's Stellar secret key
  network: "testnet",
});

const response = await client.chat({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  messages: [{ role: "user", content: "Explain quantum computing" }],
});

console.log(response.choices[0].message.content);
console.log(response._payment.transaction); // On-chain tx hash
```

That's it. The SDK:
1. Requests inference from the compute server
2. Receives HTTP 402 with JOULE payment requirements
3. Builds and signs a Soroban token transfer
4. Retries the request with the signed payment
5. Returns the AI response + payment receipt

## What is JOULE?

JOULE is a prepaid AI compute credit on the [Stellar](https://stellar.org) blockchain. 1 JOULE = 1,000 Joules of estimated AI inference energy.

- **SEP-41 compliant** Soroban token
- **x402 compatible** — the HTTP payment protocol for AI agents
- **Pay-per-query** — no minimums, no commitments
- Supports open-source models via [DeepInfra](https://deepinfra.com) (Llama, Mistral, Qwen, DeepSeek)

## Available Models

| Model | Tier | Est. Cost |
|-------|------|-----------|
| `meta-llama/Llama-3.3-70B-Instruct` | Medium | ~1.60 JOULE |
| `meta-llama/Llama-3.2-3B-Instruct` | Small | ~0.38 JOULE |
| `meta-llama/Llama-4-Scout-17B-16E-Instruct` | Medium | ~1.60 JOULE |
| `mistralai/Mistral-Small-24B-Instruct-2501` | Medium | ~1.60 JOULE |
| `Qwen/Qwen2.5-72B-Instruct` | Medium | ~1.60 JOULE |
| `deepseek-ai/DeepSeek-V3` | Large | ~8.96 JOULE |
| `deepseek-ai/DeepSeek-R1` | Reasoning | ~38.36 JOULE |

Prices are estimates based on energy consumption at default `max_tokens`. Check live pricing:

```typescript
const models = await client.models();
```

## API Reference

### `new JouleClient(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secretKey` | `string` | *required* | Stellar secret key (starts with `S`) |
| `computeUrl` | `string` | `https://compute.lumenbro.com` | Compute server URL |
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | Stellar network |
| `rpcUrl` | `string` | auto | Custom Soroban RPC URL |

### `client.chat(request): Promise<ChatResponse>`

OpenAI-compatible chat completion with automatic JOULE payment.

```typescript
const response = await client.chat({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is x402?" },
  ],
  max_tokens: 500,
  temperature: 0.7,
});

// AI response
console.log(response.choices[0].message.content);

// Payment receipt
console.log(response._payment.transaction);  // Stellar tx hash
console.log(response._payment.joulesPaid);   // "0.10 JOULE"
console.log(response._payment.network);      // "stellar:testnet"
```

### `client.models(): Promise<ModelsResponse>`

Fetch available models with live JOULE pricing.

### `client.publicKey: string`

The agent's Stellar public key (derived from the secret key).

## How x402 Works

[x402](https://www.x402.org/) turns HTTP 402 ("Payment Required") into a real payment protocol:

```
┌─────────┐         ┌──────────────────┐         ┌─────────────┐
│  Agent   │────────>│  Compute Server  │────────>│ Facilitator │
│ (SDK)    │  POST   │ compute.lumen... │ verify  │ x402.lumen..│
│          │<────────│                  │<────────│             │
│          │  402    │                  │ settle  │             │
│          │────────>│                  │────────>│             │
│          │ +X-Pay  │                  │         │             │
│          │<────────│                  │         │             │
│          │  200+AI │                  │         │             │
└─────────┘         └──────────────────┘         └─────────────┘
```

1. Agent requests inference (no payment)
2. Server returns **402** with JOULE payment requirements
3. Agent signs a Soroban token transfer and retries with `X-Payment` header
4. Server asks the facilitator to verify and settle the payment on-chain
5. Server forwards the request to the inference provider and returns the result

Every payment is a real on-chain Stellar transaction — verifiable on [Stellar Expert](https://stellar.expert/explorer/testnet).

## Running the Example

```bash
git clone https://github.com/lumenbro/joule-sdk.git
cd joule-sdk
npm install

# Set your agent's Stellar secret key
export AGENT_SECRET=SXXX...

# Run the chat example
npx tsx examples/chat.ts
```

## Network Info

| | Testnet | Mainnet |
|---|---------|---------|
| JOULE Token | `CBKI6B65...WXBMX` | Coming soon |
| Compute Server | `compute.lumenbro.com` | `compute.lumenbro.com` |
| Facilitator | `x402.lumenbro.com` | `x402.lumenbro.com` |
| Explorer | [stellar.expert/testnet](https://stellar.expert/explorer/testnet) | — |

## For Agent Frameworks

Works with any TypeScript/JavaScript agent framework:

```typescript
// LangChain-style tool
const joule = new JouleClient({ secretKey: process.env.AGENT_KEY });

async function queryLLM(prompt: string): Promise<string> {
  const res = await joule.chat({
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content;
}
```

## License

MIT
