// ─── SDK Configuration ───────────────────────────────────────────

export interface LumenJouleClientConfig {
  /** Agent's Stellar secret key (starts with S...) */
  secretKey: string;
  /** Compute server URL (default: https://compute.lumenbro.com) */
  computeUrl?: string;
  /** Soroban RPC URL (default: https://soroban-testnet.stellar.org) */
  rpcUrl?: string;
  /** Stellar network (default: mainnet) */
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
    asset: string;
    amountPaid: string;
    joulesPaid?: string;
  };
}

// ─── x402 Payment Types (v1) ────────────────────────────────────

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

// ─── x402 Payment Types (v2) ────────────────────────────────────

export interface PaymentRequirementsV2 {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  accepted: PaymentRequirementsV2;
  payload: {
    transaction: string; // unsigned TX envelope XDR (base64)
  };
}

// ─── Unified helpers ────────────────────────────────────────────

/** Normalize v1 or v2 requirements into a common shape for payment building. */
export interface NormalizedRequirements {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

export function normalizeRequirements(
  req: PaymentRequirements | PaymentRequirementsV2
): NormalizedRequirements {
  return {
    scheme: req.scheme,
    network: req.network,
    amount: "maxAmountRequired" in req ? req.maxAmountRequired : req.amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    asset: req.asset,
  };
}
