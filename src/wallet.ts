import {
  Keypair,
  Networks,
  TransactionBuilder,
  Contract,
  Address,
  Account,
  Operation,
  nativeToScVal,
  authorizeEntry,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import type {
  PaymentPayload,
  PaymentPayloadV2,
  PaymentRequirements,
  NormalizedRequirements,
} from "./types";
import { normalizeRequirements } from "./types";

const SOROBAN_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

/**
 * Build, simulate, and sign a Soroban transfer invocation for x402 payment.
 *
 * Auth entries are signed with address-based credentials so the facilitator
 * can rebuild the transaction with its own source account. Without this,
 * the facilitator's re-simulation fails with Auth/InvalidAction.
 *
 * Returns a PaymentPayload ready to be base64-encoded as an X-Payment header.
 */
export async function buildSignedPayment(
  keypair: Keypair,
  requirements: PaymentRequirements,
  network: string,
  rpcUrl?: string
): Promise<PaymentPayload> {
  const networkPassphrase = NETWORK_PASSPHRASES[network] || Networks.TESTNET;
  const sorobanUrl = rpcUrl || SOROBAN_RPC_URLS[network] || SOROBAN_RPC_URLS.testnet;
  const server = new rpc.Server(sorobanUrl);

  const contractId = requirements.asset;
  const contract = new Contract(contractId);
  const agentAddress = keypair.publicKey();

  // Build transfer(from, to, amount) invocation
  const transferOp = contract.call(
    "transfer",
    new Address(agentAddress).toScVal(),
    new Address(requirements.payTo).toScVal(),
    nativeToScVal(BigInt(requirements.maxAmountRequired), { type: "i128" })
  );

  // Load agent account for sequence number
  const account = await server.getAccount(agentAddress);
  const seqNum = account.sequenceNumber();

  const simTx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase,
  })
    .addOperation(transferOp)
    .setTimeout(300)
    .build();

  // Simulate to get auth entries and resource fees
  const simResult = await server.simulateTransaction(simTx);

  if (rpc.Api.isSimulationError(simResult)) {
    const errMsg = (simResult as any).error || "Unknown simulation error";
    throw new Error(`Simulation failed: ${errMsg}`);
  }

  const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse;

  // Sign auth entries with address-based credentials.
  // The x402 facilitator rebuilds the tx with its own source account,
  // so sourceAccount-type auth entries are invalid after rebuild.
  const latestLedger = await server.getLatestLedger();
  const validUntilLedger = latestLedger.sequence + 100;

  const rawAuthEntries: Array<string | xdr.SorobanAuthorizationEntry> =
    successSim.result?.auth || [];

  const signedAuthEntries = await Promise.all(
    rawAuthEntries.map(async (entryRaw) => {
      const entry =
        typeof entryRaw === "string"
          ? xdr.SorobanAuthorizationEntry.fromXDR(entryRaw, "base64")
          : entryRaw;

      // Convert sourceAccount → address credentials before signing.
      // authorizeEntry() only signs entries already in address format.
      if (
        entry.credentials().switch().name === "sorobanCredentialsSourceAccount"
      ) {
        const nonce = xdr.Int64.fromString(
          Math.floor(Math.random() * 2 ** 53).toString()
        );
        const addressEntry = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: new Address(agentAddress).toScAddress(),
              nonce,
              signatureExpirationLedger: validUntilLedger,
              signature: xdr.ScVal.scvVoid(),
            })
          ),
          rootInvocation: entry.rootInvocation(),
        });
        return authorizeEntry(
          addressEntry,
          keypair,
          validUntilLedger,
          networkPassphrase
        );
      }

      return authorizeEntry(entry, keypair, validUntilLedger, networkPassphrase);
    })
  );

  // Build final transaction with signed auth + soroban data
  const finalTx = new TransactionBuilder(new Account(agentAddress, seqNum), {
    fee: (
      parseInt(successSim.minResourceFee || "0", 10) + 100000
    ).toString(),
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: (simTx.operations[0] as any).func,
        auth: signedAuthEntries,
      })
    )
    .setSorobanData(successSim.transactionData.build())
    .setTimeout(300)
    .build();

  finalTx.sign(keypair);
  const signedXdr = finalTx.toXDR();

  return {
    x402Version: 1,
    scheme: "exact",
    network: `stellar:${network === "mainnet" ? "pubnet" : network}`,
    payload: {
      signedTxXdr: signedXdr,
      sourceAccount: agentAddress,
      amount: requirements.maxAmountRequired,
      destination: requirements.payTo,
      asset: contractId,
    },
  };
}

/**
 * Build a v2 payment payload (unsigned TX envelope + pre-signed auth).
 *
 * The key difference from v1: the TX is NOT signed by the agent.
 * The facilitator rebuilds the TX with its own source account.
 * Auth entries are address-based and independent of the TX source.
 *
 * Uses fee: '100' base — assembleTransaction sets the real resource fee.
 */
export async function buildSignedPaymentV2(
  keypair: Keypair,
  requirements: PaymentRequirements,
  network: string,
  rpcUrl?: string
): Promise<PaymentPayloadV2> {
  const norm = normalizeRequirements(requirements);
  const networkPassphrase = NETWORK_PASSPHRASES[network] || Networks.TESTNET;
  const sorobanUrl = rpcUrl || SOROBAN_RPC_URLS[network] || SOROBAN_RPC_URLS.testnet;
  const server = new rpc.Server(sorobanUrl);

  const contractId = norm.asset;
  const agentAddress = keypair.publicKey();

  // Build transfer(from, to, amount) invocation
  const transferArgs = [
    new Address(agentAddress).toScVal(),
    new Address(norm.payTo).toScVal(),
    nativeToScVal(BigInt(norm.amount), { type: "i128" }),
  ];

  const transferOp = new Contract(contractId).call("transfer", ...transferArgs);

  // Load agent account for sequence number
  const account = await server.getAccount(agentAddress);
  const seqNum = account.sequenceNumber();

  const baseTx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(transferOp)
    .setTimeout(300)
    .build();

  // Simulate to get auth entries and resource footprint
  const simResult = await server.simulateTransaction(baseTx);

  if (rpc.Api.isSimulationError(simResult)) {
    const errMsg = (simResult as any).error || "Unknown simulation error";
    throw new Error(`Simulation failed: ${errMsg}`);
  }

  const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse;

  // Sign auth entries with address-based credentials
  const latestLedger = await server.getLatestLedger();
  const validUntilLedger = latestLedger.sequence + 50; // ~250s, within maxTimeoutSeconds

  const rawAuthEntries: Array<string | xdr.SorobanAuthorizationEntry> =
    successSim.result?.auth || [];

  const signedAuthEntries = await Promise.all(
    rawAuthEntries.map(async (entryRaw) => {
      const entry =
        typeof entryRaw === "string"
          ? xdr.SorobanAuthorizationEntry.fromXDR(entryRaw, "base64")
          : entryRaw;

      if (
        entry.credentials().switch().name === "sorobanCredentialsSourceAccount"
      ) {
        const nonce = xdr.Int64.fromString(
          Math.floor(Math.random() * 2 ** 53).toString()
        );
        const addressEntry = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: new Address(agentAddress).toScAddress(),
              nonce,
              signatureExpirationLedger: validUntilLedger,
              signature: xdr.ScVal.scvVoid(),
            })
          ),
          rootInvocation: entry.rootInvocation(),
        });
        return authorizeEntry(
          addressEntry,
          keypair,
          validUntilLedger,
          networkPassphrase
        );
      }

      return authorizeEntry(entry, keypair, validUntilLedger, networkPassphrase);
    })
  );

  // Build assembled TX with signed auth + soroban data (unsigned envelope)
  const freshTx = new TransactionBuilder(new Account(agentAddress, seqNum), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: (baseTx.operations[0] as any).func,
        auth: signedAuthEntries,
      })
    )
    .setSorobanData(successSim.transactionData.build())
    .setTimeout(300)
    .build();

  // DO NOT sign the TX — facilitator rebuilds with its own source
  const unsignedXdr = freshTx.toEnvelope().toXDR("base64");

  const stellarNetwork = `stellar:${network === "mainnet" ? "pubnet" : network}`;
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: stellarNetwork,
      amount: norm.amount,
      payTo: norm.payTo,
      maxTimeoutSeconds: norm.maxTimeoutSeconds,
      asset: contractId,
    },
    payload: {
      transaction: unsignedXdr,
    },
  };
}
