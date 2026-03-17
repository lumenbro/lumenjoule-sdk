/**
 * Shared x402 helpers used by both LumenJouleClient and SmartWalletClient.
 *
 * Handles:
 * - Parsing 402 responses (v1 X-Payment + v2 PAYMENT-REQUIRED headers)
 * - Encoding payment headers (dual v1+v2)
 * - x402 payment dance (request → 402 → build payment → retry)
 */

import type {
  PaymentRequirements,
  PaymentRequirementsV2,
  NormalizedRequirements,
} from "./types";
import { normalizeRequirements } from "./types";

/**
 * Parse payment requirements from a 402 response.
 *
 * Checks headers in order:
 * 1. X-Payment (v1, base64 JSON) — our custom facilitator
 * 2. PAYMENT-REQUIRED (v2, base64 JSON) — OZ/standard facilitator
 * 3. Response body .paymentRequirements (v1 fallback)
 * 4. Response body .accepts[0] (v2 fallback — filter for stellar:*)
 *
 * Returns normalized requirements usable by any payment builder.
 */
export async function parsePaymentRequirements(
  response: Response,
  preferredAsset?: string
): Promise<NormalizedRequirements & { _raw: PaymentRequirements | PaymentRequirementsV2 }> {
  // If a preferred asset is specified, check for asset-specific headers first
  if (preferredAsset) {
    const stellarUsdcHeader = response.headers.get("X-Payment-Stellar-USDC");
    if (stellarUsdcHeader) {
      const req: PaymentRequirements = JSON.parse(
        Buffer.from(stellarUsdcHeader, "base64").toString("utf-8")
      );
      // Use this if the preferred asset matches
      if (req.asset === preferredAsset) {
        return { ...normalizeRequirements(req), _raw: req };
      }
    }
  }

  // Try v1 header first (our facilitator always sends this)
  const xPaymentHeader = response.headers.get("X-Payment");
  if (xPaymentHeader) {
    const req: PaymentRequirements = JSON.parse(
      Buffer.from(xPaymentHeader, "base64").toString("utf-8")
    );
    return { ...normalizeRequirements(req), _raw: req };
  }

  // Try v2 header (OZ facilitator / standard)
  const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
  if (paymentRequiredHeader) {
    const parsed = JSON.parse(
      Buffer.from(paymentRequiredHeader, "base64").toString("utf-8")
    );

    // v2 body has .accepts[] array — find a stellar:* entry
    if (parsed.accepts && Array.isArray(parsed.accepts)) {
      const stellarReq = parsed.accepts.find(
        (a: any) => typeof a.network === "string" && a.network.startsWith("stellar:")
      );
      if (stellarReq) {
        const req: PaymentRequirementsV2 = stellarReq;
        return { ...normalizeRequirements(req), _raw: req };
      }
    }

    // Single requirement object (non-array v2)
    if (parsed.amount && parsed.payTo) {
      const req: PaymentRequirementsV2 = parsed;
      return { ...normalizeRequirements(req), _raw: req };
    }
  }

  // Fall back to response body
  const body: any = await response.json();

  if (body.paymentRequirements) {
    const req: PaymentRequirements = body.paymentRequirements;
    return { ...normalizeRequirements(req), _raw: req };
  }

  if (body.accepts && Array.isArray(body.accepts)) {
    const stellarReq = body.accepts.find(
      (a: any) => typeof a.network === "string" && a.network.startsWith("stellar:")
    );
    if (stellarReq) {
      const req: PaymentRequirementsV2 = stellarReq;
      return { ...normalizeRequirements(req), _raw: req };
    }
  }

  throw new Error(
    "402 response missing payment requirements — is this an x402-enabled endpoint?"
  );
}

/**
 * Encode a payment payload as dual v1+v2 headers for maximum compatibility.
 *
 * Returns a headers object to spread into fetch() init.
 */
export function encodePaymentHeaders(payloadJson: string): Record<string, string> {
  const encoded = Buffer.from(payloadJson).toString("base64");
  return {
    "X-Payment": encoded,
    "PAYMENT-SIGNATURE": encoded,
  };
}

/**
 * Perform the x402 payment dance:
 * 1. Make initial request (expect 402)
 * 2. Parse payment requirements
 * 3. Build payment using provided builder
 * 4. Retry with payment headers
 *
 * Returns the paid response (caller handles body parsing).
 */
export async function performX402Dance(
  url: string,
  init: RequestInit,
  buildPayment: (requirements: NormalizedRequirements & { _raw: PaymentRequirements | PaymentRequirementsV2 }) => Promise<string>,
  preferredAsset?: string
): Promise<Response> {
  // Step 1: Initial request (expect 402)
  const initialResponse = await fetch(url, init);

  if (initialResponse.ok) {
    return initialResponse;
  }

  if (initialResponse.status !== 402) {
    const errorBody = await initialResponse.json().catch(() => ({}));
    throw new Error(
      `Server error (${initialResponse.status}): ${
        (errorBody as any)?.error?.message || "Unknown error"
      }`
    );
  }

  // Step 2: Parse payment requirements from 402
  const requirements = await parsePaymentRequirements(initialResponse, preferredAsset);

  // Step 3: Build payment
  const payloadJson = await buildPayment(requirements);

  // Step 4: Retry with dual payment headers
  const paymentHeaders = encodePaymentHeaders(payloadJson);

  const paidResponse = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      ...paymentHeaders,
    },
  });

  if (!paidResponse.ok) {
    const paidError = await paidResponse.json().catch(() => ({}));
    throw new Error(
      `Payment failed (${paidResponse.status}): ${
        (paidError as any)?.error?.message || "Unknown error"
      }`
    );
  }

  return paidResponse;
}
