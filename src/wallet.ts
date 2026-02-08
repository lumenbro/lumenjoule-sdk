import {
  Keypair,
  Networks,
  TransactionBuilder,
  Contract,
  Address,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "./types";

const SOROBAN_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://rpc.lightsail.network/",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

/**
 * Build, simulate, and sign a Soroban transfer invocation.
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

  // Build transfer(from, to, amount) invocation
  const transferOp = contract.call(
    "transfer",
    new Address(keypair.publicKey()).toScVal(),
    new Address(requirements.payTo).toScVal(),
    nativeToScVal(BigInt(requirements.maxAmountRequired), { type: "i128" })
  );

  // Load agent account for sequence number
  const account = await server.getAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase,
  })
    .addOperation(transferOp)
    .setTimeout(300)
    .build();

  // Simulate to get auth entries and resource fees
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const errMsg = (simResult as any).error || "Unknown simulation error";
    throw new Error(`Simulation failed: ${errMsg}`);
  }

  // Assemble with auth entries and sign
  const assembled = rpc.assembleTransaction(tx, simResult).build();
  assembled.sign(keypair);

  const signedXdr = assembled.toXDR();

  return {
    x402Version: 1,
    scheme: "exact",
    network: `stellar:${network}`,
    payload: {
      signedTxXdr: signedXdr,
      sourceAccount: keypair.publicKey(),
      amount: requirements.maxAmountRequired,
      destination: requirements.payTo,
      asset: contractId,
    },
  };
}
