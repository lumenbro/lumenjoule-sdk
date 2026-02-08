import { Keypair } from "@stellar/stellar-sdk";
import { buildSignedPayment } from "./wallet";
import type {
  JouleClientConfig,
  ChatRequest,
  ChatResponse,
  PaymentRequirements,
} from "./types";

const DEFAULT_COMPUTE_URL = "https://compute.lumenbro.com";

export class JouleClient {
  private keypair: Keypair;
  private computeUrl: string;
  private network: string;
  private rpcUrl?: string;

  constructor(config: JouleClientConfig) {
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.computeUrl = (config.computeUrl || DEFAULT_COMPUTE_URL).replace(
      /\/$/,
      ""
    );
    this.network = config.network || "testnet";
    this.rpcUrl = config.rpcUrl;
  }

  /** Agent's public Stellar address */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Send a chat completion request, automatically handling x402 payment.
   *
   * Flow:
   * 1. POST to /api/v1/chat/completions (no payment)
   * 2. Get 402 → extract payment requirements
   * 3. Build + sign Soroban transfer
   * 4. Retry with X-Payment header
   * 5. Return inference response + payment metadata
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.computeUrl}/api/v1/chat/completions`;

    // Step 1: Initial request (expect 402)
    const initialResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: false }),
    });

    // If we get 200, the endpoint doesn't require payment (shouldn't happen, but handle it)
    if (initialResponse.ok) {
      return initialResponse.json() as Promise<ChatResponse>;
    }

    // Not a 402? It's an actual error
    if (initialResponse.status !== 402) {
      const errorBody = await initialResponse.json().catch(() => ({}));
      throw new Error(
        `Compute server error (${initialResponse.status}): ${
          (errorBody as any)?.error?.message || "Unknown error"
        }`
      );
    }

    // Step 2: Extract payment requirements from 402 response
    const errorBody: any = await initialResponse.json();
    const requirements: PaymentRequirements = errorBody.paymentRequirements;

    if (!requirements) {
      throw new Error(
        "402 response missing paymentRequirements — is this an x402-enabled endpoint?"
      );
    }

    // Step 3: Build and sign Soroban transfer
    const paymentPayload = await buildSignedPayment(
      this.keypair,
      requirements,
      this.network,
      this.rpcUrl
    );

    // Step 4: Encode as base64 and retry with X-Payment header
    const paymentHeader = Buffer.from(
      JSON.stringify(paymentPayload)
    ).toString("base64");

    const paidResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!paidResponse.ok) {
      const paidError = await paidResponse.json().catch(() => ({}));
      throw new Error(
        `Payment failed (${paidResponse.status}): ${
          (paidError as any)?.error?.message || "Unknown error"
        }`
      );
    }

    // Step 5: Return response with payment metadata
    return paidResponse.json() as Promise<ChatResponse>;
  }

  /**
   * Get available models and their JOULE pricing.
   */
  async models(): Promise<any> {
    const response = await fetch(`${this.computeUrl}/api/models`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }
    return response.json();
  }
}
