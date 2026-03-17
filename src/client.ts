import { Keypair } from "@stellar/stellar-sdk";
import { buildSignedPayment } from "./wallet";
import { performX402Dance } from "./x402-helpers";
import type {
  LumenJouleClientConfig,
  ChatRequest,
  ChatResponse,
  PaymentRequirements,
} from "./types";

const DEFAULT_COMPUTE_URL = "https://compute.lumenbro.com";

/**
 * LumenJoule SDK client — pay for AI inference with LumenJoule tokens on Stellar.
 *
 * Handles the x402 payment protocol automatically:
 * 1. POST to compute server (expect 402)
 * 2. Extract payment requirements (v1 X-Payment or v2 PAYMENT-REQUIRED)
 * 3. Build + sign Soroban transfer
 * 4. Retry with both X-Payment and PAYMENT-SIGNATURE headers
 * 5. Return inference response + payment metadata
 */
export class LumenJouleClient {
  private keypair: Keypair;
  private computeUrl: string;
  private network: string;
  private rpcUrl?: string;

  constructor(config: LumenJouleClientConfig) {
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.computeUrl = (config.computeUrl || DEFAULT_COMPUTE_URL).replace(
      /\/$/,
      ""
    );
    this.network = config.network || "mainnet";
    this.rpcUrl = config.rpcUrl;
  }

  /** Agent's public Stellar address */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Send a chat completion request, automatically handling x402 payment.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.computeUrl}/api/v1/chat/completions`;

    const response = await performX402Dance(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, stream: false }),
      },
      async (requirements) => {
        // Reconstruct v1 PaymentRequirements for backward-compatible builder
        const v1Req: PaymentRequirements = {
          scheme: requirements.scheme,
          network: requirements.network,
          maxAmountRequired: requirements.amount,
          resource: url,
          description: "",
          payTo: requirements.payTo,
          maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          asset: requirements.asset,
        };

        const paymentPayload = await buildSignedPayment(
          this.keypair,
          v1Req,
          this.network,
          this.rpcUrl
        );

        return JSON.stringify(paymentPayload);
      }
    );

    return response.json() as Promise<ChatResponse>;
  }

  /**
   * Get available models and their LumenJoule pricing.
   */
  async models(): Promise<any> {
    const response = await fetch(`${this.computeUrl}/api/models`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }
    return response.json();
  }
}

/** @deprecated Use LumenJouleClient instead */
export { LumenJouleClient as JouleClient };
