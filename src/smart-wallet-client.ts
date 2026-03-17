/**
 * SmartWalletClient — x402 payments from a C-address smart wallet.
 *
 * Supports pluggable signers: Ed25519 (keypair), Secp256r1 (Secure Enclave / software P-256).
 * Compatible with OZ facilitator and LumenJoule custom facilitator.
 *
 * The agent's signer signs auth entries (not the TX envelope).
 * The facilitator rebuilds and submits the TX with its own source account.
 */

import {
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  Contract,
  Account,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import { buildSmartWalletAuth, buildI128 } from "./smart-wallet-auth";
import { performX402Dance } from "./x402-helpers";
import { Ed25519AgentSigner } from "./signers/ed25519";
import type { AgentSigner } from "./signers/types";
import type { SmartWalletClientConfig } from "./smart-wallet-types";
import type {
  ChatRequest,
  ChatResponse,
  NormalizedRequirements,
  PaymentPayloadV2,
} from "./types";

const DEFAULT_COMPUTE_URL = "https://compute.lumenbro.com";

const SOROBAN_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

// Default source accounts for simulation (facilitator addresses, always funded)
const DEFAULT_SOURCE_ACCOUNTS: Record<string, string> = {
  mainnet: "GD4DCTKEB3Z2QZUNSAWQAT57TS6LO2ATNNOIMV2DLRFLFGWBVWJODUHT",
  testnet: "GBPUEDMWGNHUJBV3YK3MEMF7O3HYZ5JLLC634ALSHWIVGLY3GLZM6FMR",
};

// USDC SAC addresses per network
const USDC_SAC: Record<string, string> = {
  mainnet: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  testnet: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};

export class SmartWalletClient {
  private signer: AgentSigner;
  private walletAddress: string;
  private computeUrl: string;
  private network: string;
  private rpcUrl: string;
  private networkPassphrase: string;
  private sourceAccount: string;
  private preferredAsset: string;
  private policyAddress?: string;

  constructor(config: SmartWalletClientConfig) {
    // Initialize signer: pluggable signer takes priority, else wrap Ed25519 key
    if (config.signer) {
      this.signer = config.signer;
    } else if (config.agentSecretKey) {
      this.signer = new Ed25519AgentSigner(config.agentSecretKey);
    } else {
      throw new Error(
        "SmartWalletClient requires agentSecretKey or signer"
      );
    }

    this.walletAddress = config.walletAddress;
    this.computeUrl = (config.computeUrl || DEFAULT_COMPUTE_URL).replace(
      /\/$/,
      ""
    );
    this.network = config.network || "mainnet";
    this.rpcUrl =
      config.rpcUrl ||
      SOROBAN_RPC_URLS[this.network] ||
      SOROBAN_RPC_URLS.testnet;
    this.networkPassphrase =
      NETWORK_PASSPHRASES[this.network] || Networks.TESTNET;

    // Resolve source account for TX building / simulation.
    // For x402 payments, the facilitator replaces the TX source entirely —
    // this is just a placeholder for simulation. Agent keys (Ed25519 or P-256)
    // don't need to be funded since they only sign auth entries, not TX envelopes.
    // Default to the facilitator address (always funded) for all signer types.
    this.sourceAccount =
      config.sourceAccount ||
      DEFAULT_SOURCE_ACCOUNTS[this.network] ||
      DEFAULT_SOURCE_ACCOUNTS.mainnet;

    // Default preferred asset to USDC (most agent wallets hold USDC, not LJOULE)
    this.preferredAsset =
      config.preferredAsset ||
      USDC_SAC[this.network] ||
      USDC_SAC.mainnet;

    this.policyAddress = config.policyAddress;
  }

  /**
   * Agent's public Stellar address (G-address, the signer — not the wallet).
   * Only available for Ed25519 signers. Returns undefined for Secp256r1 signers.
   */
  get agentPublicKey(): string | undefined {
    return this.signer instanceof Ed25519AgentSigner
      ? this.signer.publicKey
      : undefined;
  }

  /** Signer type ('Ed25519' or 'Secp256r1') */
  get signerType(): string {
    return this.signer.type;
  }

  /** Smart wallet contract address (C-address, the payer) */
  get address(): string {
    return this.walletAddress;
  }

  /**
   * Send a chat completion request, automatically handling x402 payment
   * from the smart wallet.
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
        const payload = await this.buildSmartWalletPayment(requirements);
        return JSON.stringify(payload);
      },
      this.preferredAsset
    );

    return response.json() as Promise<ChatResponse>;
  }

  /**
   * Generic x402 payment for any endpoint.
   * Handles the 402 dance and returns the paid response.
   */
  async payAndFetch(url: string, init?: RequestInit): Promise<Response> {
    return performX402Dance(
      url,
      init || { method: "GET" },
      async (requirements) => {
        const payload = await this.buildSmartWalletPayment(requirements);
        return JSON.stringify(payload);
      },
      this.preferredAsset
    );
  }

  /**
   * Direct token transfer from the smart wallet (non-x402, agent pays gas).
   * Returns the transaction hash.
   *
   * NOTE: Requires Ed25519 signer with a funded G-address (for gas).
   * Secp256r1 signers cannot sign TX envelopes — use x402 payments instead.
   */
  async transfer(
    token: string,
    to: string,
    amount: bigint
  ): Promise<string> {
    if (!(this.signer instanceof Ed25519AgentSigner)) {
      throw new Error(
        "transfer() requires an Ed25519 signer. Secp256r1 signers cannot sign Stellar TX envelopes. " +
          "Use x402 payments (chat/payAndFetch) instead, or use a separate gas payer."
      );
    }

    const agentKeypair = this.signer.keypair;
    const server = new rpc.Server(this.rpcUrl);

    const transferArgs = [
      Address.fromString(this.walletAddress).toScVal(),
      Address.fromString(to).toScVal(),
      buildI128(amount),
    ];

    // Build the invocation for auth signing
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(token).toScAddress(),
            functionName: "transfer",
            args: transferArgs,
          })
        ),
      subInvocations: [],
    });

    const { sequence: latestLedger } = await server.getLatestLedger();
    const expirationLedger = latestLedger + 50;

    const signedAuthEntry = await buildSmartWalletAuth(
      this.walletAddress,
      this.signer,
      invocation,
      expirationLedger,
      this.networkPassphrase
    );

    // Build, simulate, assemble, sign, submit
    const agentAccount = await server.getAccount(agentKeypair.publicKey());
    const seqNum = agentAccount.sequenceNumber();

    const baseTx = new TransactionBuilder(agentAccount, {
      fee: "10000000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: token,
          function: "transfer",
          args: transferArgs,
          auth: [signedAuthEntry],
        })
      )
      .setTimeout(300)
      .build();

    const sim = await server.simulateTransaction(baseTx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(
        `Transfer simulation failed: ${(sim as any).error || "unknown"}`
      );
    }

    const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;

    // Reassemble with fresh sequence and restore auth
    const freshTx = new TransactionBuilder(
      new Account(agentKeypair.publicKey(), seqNum),
      { fee: "10000000", networkPassphrase: this.networkPassphrase }
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: token,
          function: "transfer",
          args: transferArgs,
          auth: [signedAuthEntry],
        })
      )
      .setTimeout(300)
      .build();

    const assembled = rpc.assembleTransaction(freshTx, successSim).build();
    // Restore pre-signed auth (assembleTransaction replaces with sim skeleton)
    (assembled.operations[0] as any).auth = [signedAuthEntry];

    // Bump instructions for safety
    const sorobanData = assembled
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData();
    const resources = sorobanData.resources();
    resources.instructions(Math.ceil(resources.instructions() * 1.25));

    assembled.sign(agentKeypair);

    const resp = await server.sendTransaction(assembled);
    if (resp.status === "ERROR") {
      throw new Error(`Transfer submit failed: ${JSON.stringify(resp)}`);
    }

    // Poll for confirmation
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await server.getTransaction(resp.hash);
      if (status.status === "SUCCESS") return resp.hash;
      if (status.status === "FAILED") {
        throw new Error(`Transfer failed on-chain: ${resp.hash}`);
      }
    }
    throw new Error(`Transfer not confirmed after 60s: ${resp.hash}`);
  }

  /**
   * Get token balance of the smart wallet.
   * Defaults to LumenJoule SAC on the configured network.
   */
  async balance(token?: string): Promise<bigint> {
    const server = new rpc.Server(this.rpcUrl);
    const contract = new Contract(token || this.defaultAsset());

    const account = await server.getAccount(this.sourceAccount);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "balance",
          Address.fromString(this.walletAddress).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(
        `Balance query failed: ${(sim as any).error || "unknown"}`
      );
    }

    const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
    const retVal = successSim.result?.retval;
    if (!retVal) return 0n;

    return scValToBigInt(retVal);
  }

  /**
   * Get XLM balance of the smart wallet (for gas estimation).
   */
  async gasBalance(): Promise<bigint> {
    const xlmSac =
      this.network === "mainnet"
        ? "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
        : "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    return this.balance(xlmSac);
  }

  /**
   * Get USDC balance of the smart wallet.
   * Returns balance in 7-decimal stroops (divide by 1e7 for human-readable).
   */
  async usdcBalance(): Promise<bigint> {
    return this.balance(USDC_SAC[this.network] || USDC_SAC.mainnet);
  }

  // ─── Spend Policy Queries ─────────────────────────────────────

  /**
   * Query USDC-equivalent amount spent today by this wallet against the spend policy.
   * Returns value in 7-decimal stroops (divide by 1e7 for USD).
   *
   * Requires `policyAddress` in config.
   */
  async spentToday(): Promise<bigint> {
    return this.queryPolicy("spent_today", [
      Address.fromString(this.walletAddress).toScVal(),
    ]);
  }

  /**
   * Query remaining daily budget for this wallet from the spend policy.
   * Returns value in 7-decimal stroops (divide by 1e7 for USD).
   *
   * Requires `policyAddress` in config.
   */
  async remaining(): Promise<bigint> {
    return this.queryPolicy("remaining", [
      Address.fromString(this.walletAddress).toScVal(),
    ]);
  }

  /**
   * Query the daily limit configured on the spend policy contract.
   * Returns value in 7-decimal stroops (divide by 1e7 for USD).
   *
   * Requires `policyAddress` in config.
   */
  async dailyLimit(): Promise<bigint> {
    return this.queryPolicy("daily_limit", []);
  }

  /**
   * Get a snapshot of spend budget status (all three queries in one call).
   *
   * Requires `policyAddress` in config.
   */
  async budgetStatus(): Promise<{
    dailyLimitUsdc: number;
    spentTodayUsdc: number;
    remainingUsdc: number;
  }> {
    const [limit, spent, rem] = await Promise.all([
      this.dailyLimit(),
      this.spentToday(),
      this.remaining(),
    ]);
    return {
      dailyLimitUsdc: Number(limit) / 1e7,
      spentTodayUsdc: Number(spent) / 1e7,
      remainingUsdc: Number(rem) / 1e7,
    };
  }

  // ─── Private methods ──────────────────────────────────────────

  /**
   * Query a spend policy contract view function via simulation.
   */
  private async queryPolicy(fn: string, args: xdr.ScVal[]): Promise<bigint> {
    if (!this.policyAddress) {
      throw new Error(
        `${fn}() requires policyAddress in SmartWalletClient config. ` +
          "Pass the spend policy contract address for your tier."
      );
    }

    const server = new rpc.Server(this.rpcUrl);
    const contract = new Contract(this.policyAddress);
    const account = await server.getAccount(this.sourceAccount);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(fn, ...args))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(
        `Policy query ${fn}() failed: ${(sim as any).error || "unknown"}`
      );
    }

    const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
    const retVal = successSim.result?.retval;
    if (!retVal) return 0n;

    return scValToBigInt(retVal);
  }

  private defaultAsset(): string {
    return this.network === "mainnet"
      ? "CBVWPBYEDJ7GYIUHL2HITMEEWM75WAMFINIQCR4ZAFZ62ISDFBVERQCX" // LumenJoule mainnet
      : "CCFVNEQCBMTCJKI24G543SPMQWUZPARRSMBXCYIYI25XBUQSCSRNVJNY"; // LumenJoule testnet
  }

  /**
   * Build a smart wallet payment payload for x402.
   *
   * Flow:
   * 1. Build transfer(C_address, payTo, amount) invocation
   * 2. Pre-sign auth with buildSmartWalletAuth() (pluggable signer)
   * 3. Build TX (fee: '100', sourceAccount as placeholder)
   * 4. Simulate (validates __check_auth + spend policy)
   * 5. Assemble, restore auth entries, bump instructions
   * 6. Return unsigned envelope as v2 PaymentPayload
   */
  private async buildSmartWalletPayment(
    requirements: NormalizedRequirements
  ): Promise<PaymentPayloadV2> {
    const server = new rpc.Server(this.rpcUrl);
    const contractId = requirements.asset;
    const amount = BigInt(requirements.amount);

    const transferArgs = [
      Address.fromString(this.walletAddress).toScVal(),
      Address.fromString(requirements.payTo).toScVal(),
      buildI128(amount),
    ];

    // Build the invocation tree for auth signing
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: "transfer",
            args: transferArgs,
          })
        ),
      subInvocations: [],
    });

    const { sequence: latestLedger } = await server.getLatestLedger();
    const expirationLedger = latestLedger + 50; // ~250s

    // Pre-sign auth entry with C-address credentials (pluggable signer)
    const signedAuthEntry = await buildSmartWalletAuth(
      this.walletAddress,
      this.signer,
      invocation,
      expirationLedger,
      this.networkPassphrase
    );

    // Build base TX (fee: '100', sourceAccount as placeholder)
    const account = await server.getAccount(this.sourceAccount);
    const seqNum = account.sequenceNumber();

    const baseTx = new TransactionBuilder(
      new Account(this.sourceAccount, seqNum),
      { fee: "100", networkPassphrase: this.networkPassphrase }
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "transfer",
          args: transferArgs,
          auth: [signedAuthEntry],
        })
      )
      .setTimeout(300)
      .build();

    // Simulate to get resource footprint
    const sim = await server.simulateTransaction(baseTx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(
        `Payment simulation failed: ${(sim as any).error || "unknown"}`
      );
    }

    const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;

    // Assemble with sim data, restore pre-signed auth
    const freshTx = new TransactionBuilder(
      new Account(this.sourceAccount, seqNum),
      { fee: "100", networkPassphrase: this.networkPassphrase }
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "transfer",
          args: transferArgs,
          auth: [signedAuthEntry],
        })
      )
      .setTimeout(300)
      .build();

    const assembled = rpc.assembleTransaction(freshTx, successSim).build();
    (assembled.operations[0] as any).auth = [signedAuthEntry];

    // Bump instructions for safety
    const sorobanData = assembled
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData();
    const resources = sorobanData.resources();
    resources.instructions(Math.ceil(resources.instructions() * 1.25));

    // DO NOT sign — facilitator rebuilds with its own source
    const unsignedXdr = assembled.toEnvelope().toXDR("base64");

    const stellarNetwork = `stellar:${
      this.network === "mainnet" ? "pubnet" : this.network
    }`;

    return {
      x402Version: 2,
      accepted: {
        scheme: requirements.scheme,
        network: stellarNetwork,
        amount: requirements.amount,
        payTo: requirements.payTo,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        asset: contractId,
      },
      payload: {
        transaction: unsignedXdr,
      },
    };
  }
}

/** Extract bigint from ScVal (i128) */
function scValToBigInt(val: xdr.ScVal): bigint {
  const i128 = val.i128();
  const hi = BigInt(i128.hi().toString());
  const lo = BigInt(i128.lo().toString());
  return (hi << 64n) | lo;
}
