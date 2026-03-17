// ─── Smart Wallet Client Configuration ──────────────────────────

import type { AgentSigner } from "./signers/types";

export interface SmartWalletClientConfig {
  /** Smart wallet C-address (starts with C...) */
  walletAddress: string;

  // ─── Signer (provide one of the following) ──────────────────
  /** Ed25519 secret key (starts with S...) — backward compatible */
  agentSecretKey?: string;
  /** Pluggable signer (Ed25519, KeypoSigner, SoftP256Signer, or custom) */
  signer?: AgentSigner;

  // ─── Common ─────────────────────────────────────────────────
  /** Compute server URL (default: https://compute.lumenbro.com) */
  computeUrl?: string;
  /** Stellar network (default: mainnet) */
  network?: "testnet" | "mainnet";
  /** Soroban RPC URL (auto-detected from network if not provided) */
  rpcUrl?: string;
  /**
   * G-address used as TX source for simulation (placeholder only).
   * Defaults to the facilitator address (always funded) for all signer types.
   * Agent keys don't need funding for x402 — they only sign auth entries.
   * Only needed for transfer() where the agent pays gas directly.
   */
  sourceAccount?: string;

  /**
   * Preferred payment asset SAC address (C-address).
   * Defaults to USDC SAC for the configured network.
   * Set to 'ljoule' to prefer LumenJoule payments.
   */
  preferredAsset?: string;

  /**
   * Spend policy contract address (C-address).
   * Required for spentToday() / remaining() / dailyLimit() queries.
   * If not provided, these methods will throw.
   *
   * Mainnet tiers:
   *   Starter ($50/day):    CBRGH27ZFVFDIHYKC4K3CSLKXHQSR5CFG2PLPZ2M37NH4PYBOBTTQAEC
   *   Production ($500/day): CCRIFGLMG3PT7R3V2IFSRNDNKR2Y2DLJAI5KXYBKNJPFCL2QC4MDIZNJ
   *   Enterprise ($2K/day):  CCSPAXNEVBNA5QAEU2YEUTU56O5KOZM4C2O7ONQ6GFPSHEWV5OJJS5H2
   */
  policyAddress?: string;
}
