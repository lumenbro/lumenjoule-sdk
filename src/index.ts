export { LumenJouleClient, JouleClient } from "./client";
export { SmartWalletClient } from "./smart-wallet-client";
export { buildSignedPayment, buildSignedPaymentV2 } from "./wallet";
export { buildSmartWalletAuth } from "./smart-wallet-auth";
export {
  parsePaymentRequirements,
  encodePaymentHeaders,
  performX402Dance,
} from "./x402-helpers";

// Pluggable signers
export { Ed25519AgentSigner, KeypoSigner, SoftP256Signer, computeKeyId } from "./signers";
export type { AgentSigner, SignedAuthProof, KeypoSignerConfig } from "./signers";

// Types
export type {
  LumenJouleClientConfig,
  JouleClientConfig,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  PaymentRequirements,
  PaymentPayload,
  PaymentRequirementsV2,
  PaymentPayloadV2,
  NormalizedRequirements,
} from "./types";
export type { SmartWalletClientConfig } from "./smart-wallet-types";
