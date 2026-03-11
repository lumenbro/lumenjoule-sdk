# lumenjoule-sdk

Pay for AI inference with LumenJoule tokens on Stellar. Handles x402 payment protocol automatically.

## Install

```bash
npm install lumenjoule-sdk
```

## Quick Start

```typescript
import { LumenJouleClient } from "lumenjoule-sdk";

const client = new LumenJouleClient({
  secretKey: "SXXXX...",  // Agent's Stellar secret key
  network: "mainnet",
});

const response = await client.chat({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
console.log("Paid:", response._payment.ljoulesPaid, "LumenJoule");
```

## API

### `new LumenJouleClient(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secretKey` | `string` | required | Agent's Stellar secret key (S...) |
| `computeUrl` | `string` | `https://compute.lumenbro.com` | Compute server URL |
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | Stellar network |
| `rpcUrl` | `string` | auto | Custom Soroban RPC URL |

### `client.chat(request)`

OpenAI-compatible chat completion with automatic x402 payment.

### `client.models()`

List available models and their LumenJoule pricing.

## Links

- [LumenJoule Token](https://joule.lumenbro.com)
- [x402 Protocol](https://x402.org)
- [GitHub](https://github.com/lumenbro/lumenjoule-sdk)
