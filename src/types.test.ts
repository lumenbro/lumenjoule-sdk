import { describe, it, expect } from "vitest";
import {
  normalizeRequirements,
  type PaymentRequirements,
  type PaymentRequirementsV2,
} from "./types";

describe("normalizeRequirements", () => {
  it("normalizes v1 PaymentRequirements (maxAmountRequired → amount)", () => {
    const v1: PaymentRequirements = {
      scheme: "exact",
      network: "stellar:pubnet",
      maxAmountRequired: "5000000",
      resource: "https://compute.lumenbro.com/api/v1/chat/completions",
      description: "AI inference",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 60,
      asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    };

    const normalized = normalizeRequirements(v1);

    expect(normalized.amount).toBe("5000000");
    expect(normalized.scheme).toBe("exact");
    expect(normalized.network).toBe("stellar:pubnet");
    expect(normalized.payTo).toBe(v1.payTo);
    expect(normalized.maxTimeoutSeconds).toBe(60);
    expect(normalized.asset).toBe(v1.asset);
  });

  it("normalizes v2 PaymentRequirementsV2 (amount stays amount)", () => {
    const v2: PaymentRequirementsV2 = {
      scheme: "exact",
      network: "stellar:pubnet",
      amount: "3000000",
      payTo: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
      maxTimeoutSeconds: 30,
      asset: "CBVWPBYEDJ7GYIUHL2HITMEEWM75WAMFINIQCR4ZAFZ62ISDFBVERQCX",
    };

    const normalized = normalizeRequirements(v2);

    expect(normalized.amount).toBe("3000000");
    expect(normalized.scheme).toBe("exact");
    expect(normalized.network).toBe("stellar:pubnet");
    expect(normalized.payTo).toBe(v2.payTo);
    expect(normalized.maxTimeoutSeconds).toBe(30);
    expect(normalized.asset).toBe(v2.asset);
  });
});
