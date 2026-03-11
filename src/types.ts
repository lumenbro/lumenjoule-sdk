// ─── SDK Configuration ───────────────────────────────────────────

export interface LumenJouleClientConfig {
  /** Agent's Stellar secret key (starts with S...) */
  secretKey: string;
  /** Compute server URL (default: https://compute.lumenbro.com) */
  computeUrl?: string;
  /** Soroban RPC URL (default: https://soroban-testnet.stellar.org) */
  rpcUrl?: string;
  /** Stellar network (default: testnet) */
  network?: "testnet" | "mainnet";
}

/** @deprecated Use LumenJouleClientConfig instead */
export type JouleClientConfig = LumenJouleClientConfig;

// ─── Chat Types (OpenAI-compatible) ─────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  _payment: {
    transaction: string;
    network: string;
    payer: string;
    ljoulesPaid: string;
  };
}

// ─── x402 Payment Types ─────────────────────────────────────────

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signedTxXdr: string;
    sourceAccount: string;
    amount: string;
    destination: string;
    asset: string;
  };
}
