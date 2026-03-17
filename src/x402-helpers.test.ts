import { describe, it, expect } from "vitest";
import { encodePaymentHeaders, parsePaymentRequirements } from "./x402-helpers";

describe("encodePaymentHeaders", () => {
  it("encodes payload as base64 in both X-Payment and PAYMENT-SIGNATURE", () => {
    const payload = JSON.stringify({ x402Version: 2, payload: { transaction: "AAAA" } });
    const headers = encodePaymentHeaders(payload);

    expect(headers["X-Payment"]).toBeDefined();
    expect(headers["PAYMENT-SIGNATURE"]).toBeDefined();
    expect(headers["X-Payment"]).toBe(headers["PAYMENT-SIGNATURE"]);

    // Verify round-trip
    const decoded = Buffer.from(headers["X-Payment"], "base64").toString("utf-8");
    expect(decoded).toBe(payload);
  });

  it("handles empty payload", () => {
    const headers = encodePaymentHeaders("");
    const decoded = Buffer.from(headers["X-Payment"], "base64").toString("utf-8");
    expect(decoded).toBe("");
  });
});

describe("parsePaymentRequirements", () => {
  it("parses v1 X-Payment header", async () => {
    const v1Req = {
      scheme: "exact",
      network: "stellar:pubnet",
      maxAmountRequired: "5000000",
      resource: "https://compute.lumenbro.com/api/v1/chat/completions",
      description: "AI inference",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 60,
      asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    };

    const encoded = Buffer.from(JSON.stringify(v1Req)).toString("base64");
    const response = new Response(null, {
      status: 402,
      headers: { "X-Payment": encoded },
    });

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("5000000");
    expect(result.payTo).toBe(v1Req.payTo);
    expect(result.asset).toBe(v1Req.asset);
    expect(result._raw).toEqual(v1Req);
  });

  it("parses v2 PAYMENT-REQUIRED header (single object)", async () => {
    const v2Req = {
      scheme: "exact",
      network: "stellar:pubnet",
      amount: "3000000",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 30,
      asset: "CBVWPBYEDJ7GYIUHL2HITMEEWM75WAMFINIQCR4ZAFZ62ISDFBVERQCX",
    };

    const encoded = Buffer.from(JSON.stringify(v2Req)).toString("base64");
    const response = new Response(null, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encoded },
    });

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("3000000");
    expect(result.payTo).toBe(v2Req.payTo);
  });

  it("parses v2 PAYMENT-REQUIRED header with accepts[] array", async () => {
    const v2Body = {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:pubnet",
          amount: "7000000",
          payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
          maxTimeoutSeconds: 60,
          asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        },
      ],
    };

    const encoded = Buffer.from(JSON.stringify(v2Body)).toString("base64");
    const response = new Response(null, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encoded },
    });

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("7000000");
    expect(result.network).toBe("stellar:pubnet");
  });

  it("falls back to body .paymentRequirements (v1)", async () => {
    const v1Req = {
      scheme: "exact",
      network: "stellar:pubnet",
      maxAmountRequired: "1000000",
      resource: "/api/v1/chat/completions",
      description: "",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 60,
      asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    };

    const response = new Response(JSON.stringify({ paymentRequirements: v1Req }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("1000000");
  });

  it("falls back to body .accepts[] (v2)", async () => {
    const body = {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:pubnet",
          amount: "2000000",
          payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
          maxTimeoutSeconds: 30,
          asset: "CBVWPBYEDJ7GYIUHL2HITMEEWM75WAMFINIQCR4ZAFZ62ISDFBVERQCX",
        },
      ],
    };

    const response = new Response(JSON.stringify(body), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("2000000");
  });

  it("throws when no payment requirements found", async () => {
    const response = new Response(JSON.stringify({}), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });

    await expect(parsePaymentRequirements(response)).rejects.toThrow(
      "402 response missing payment requirements"
    );
  });

  it("prefers X-Payment header over body", async () => {
    const headerReq = {
      scheme: "exact",
      network: "stellar:pubnet",
      maxAmountRequired: "9000000",
      resource: "/api",
      description: "",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 60,
      asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    };

    const bodyReq = { ...headerReq, maxAmountRequired: "1000000" };

    const encoded = Buffer.from(JSON.stringify(headerReq)).toString("base64");
    const response = new Response(
      JSON.stringify({ paymentRequirements: bodyReq }),
      {
        status: 402,
        headers: {
          "X-Payment": encoded,
          "Content-Type": "application/json",
        },
      }
    );

    const result = await parsePaymentRequirements(response);
    expect(result.amount).toBe("9000000"); // from header, not body
  });
});
