import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  MessageV0,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import fs from 'fs';
import dotenv from 'dotenv';
import axios from 'axios';
import bs58 from 'bs58';

dotenv.config();

const ATLAS_SERVICE_URL = process.env.ATLAS_SERVICE_URL;
const RPC_URL = process.env.RPC_URL;

if (!ATLAS_SERVICE_URL || !RPC_URL) {
  throw new Error('ATLAS_SERVICE_URL and RPC_URL must be set');
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result: string; // transaction signature
  id: number;
}

interface JsonRpcBundleResponse {
  jsonrpc: '2.0';
  result: string[]; // transaction signatures
  id: number;
}

type TestMode =
  | 'valid-single'
  | 'invalid-single'
  | 'valid-bundle'
  | 'invalid-bundle-first'
  | 'invalid-bundle-second';

async function loadKeypair(): Promise<Keypair> {
  const keypairData = JSON.parse(fs.readFileSync('keypair.json', 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

async function createTestTransaction(
  fromKeypair: Keypair,
  toPubkey: PublicKey,
  amount: bigint,
  blockhash: string
): Promise<VersionedTransaction> {
  const instruction = SystemProgram.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey: toPubkey,
    lamports: amount,
  });

  const messageV0 = new MessageV0({
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    },
    staticAccountKeys: [
      fromKeypair.publicKey,
      toPubkey,
      SystemProgram.programId,
    ],
    recentBlockhash: blockhash,
    compiledInstructions: [
      {
        programIdIndex: 2, // SystemProgram index
        accountKeyIndexes: [0, 1], // from and to account indices
        data: instruction.data,
      },
    ],
    addressTableLookups: [],
  });

  return new VersionedTransaction(messageV0);
}

async function sendTransaction(
  tx: VersionedTransaction
): Promise<JsonRpcResponse> {
  const serializedTx = bs58.encode(tx.serialize());
  try {
    const response = await axios.post<JsonRpcResponse>(`${ATLAS_SERVICE_URL}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        serializedTx,
        {
          skipPreflight: true,
          encoding: 'base58',
        },
      ],
    });
    console.log('Transaction status:', response.status);
    console.log('Request data:', response.config.data);
    console.log('Response data:', response.data);
    return response.data;
  } catch (err) {
    console.error('Error sending transaction:', err);
    throw err;
  }
}

async function sendTransactionBundle(
  txs: VersionedTransaction[]
): Promise<JsonRpcBundleResponse> {
  const serializedTxs = txs.map((tx) => bs58.encode(tx.serialize()));
  try {
    const response = await axios.post<JsonRpcBundleResponse>(
      `${ATLAS_SERVICE_URL}`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransactionBundle',
        params: [
          serializedTxs,
          {
            skipPreflight: true,
            encoding: 'base58',
          },
        ],
      }
    );
    console.log('Transaction status:', response.status);
    console.log('Request data:', response.config.data);
    console.log('Response data:', response.data);
    return response.data;
  } catch (err) {
    console.error('Error sending transaction bundle:', err);
    throw err;
  }
}

async function checkBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<bigint> {
  const balance = await connection.getBalance(pubkey);
  return BigInt(balance);
}

function formatSol(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
}

async function confirmTransaction(connection: Connection, signature: string) {
  const latestBlockhash = await connection.getLatestBlockhash();
  return await connection.confirmTransaction(
    {
      signature,
      ...latestBlockhash,
    },
    'finalized'
  );
}

async function runTest(mode: TestMode) {
  const keypair = await loadKeypair();
  console.log('Loaded keypair w/ public key:', keypair.publicKey.toString());

  // Create test recipients (only as many as needed)
  const numRecipients = mode.includes('bundle') ? 2 : 1;
  const recipients = Array(numRecipients)
    .fill(null)
    .map(() => Keypair.generate());

  console.log('Created recipients with public keys:');
  recipients.forEach((recipient, i) => {
    console.log(`Recipient ${i + 1}:`, recipient.publicKey.toString());
  });

  const connection = new Connection(RPC_URL!);

  const senderInitialBalance = await checkBalance(
    connection,
    keypair.publicKey
  );
  console.log(`Sender initial balance: ${formatSol(senderInitialBalance)}`);

  const recipientInitialBalances = await Promise.all(
    recipients.map(async (recipient, i) => {
      const balance = await checkBalance(connection, recipient.publicKey);
      console.log(`Recipient ${i + 1} initial balance: ${formatSol(balance)}`);
      return balance;
    })
  );

  let expectedSenderChange = BigInt(0);
  const expectedRecipientChanges: bigint[] = Array(numRecipients).fill(
    BigInt(0)
  );

  let transactions: VersionedTransaction[] = [];
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const txnFee = BigInt(5000);

  switch (mode) {
    case 'valid-single': {
      const amount = BigInt(0.01 * LAMPORTS_PER_SOL);
      expectedSenderChange -= amount + txnFee;
      expectedRecipientChanges[0] += amount;
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          amount,
          recentBlockhash
        ),
      ];
      break;
    }

    case 'invalid-single': {
      const amount = BigInt(LAMPORTS_PER_SOL * 0.03);
      expectedSenderChange -= amount + txnFee;
      expectedRecipientChanges[0] += amount;
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          amount,
          '11111111111111111111111111111111' // Stale blockhash
        ),
      ];
      break;
    }

    case 'valid-bundle': {
      const amount1 = BigInt(LAMPORTS_PER_SOL * 0.01);
      const amount2 = BigInt(LAMPORTS_PER_SOL * 0.02);
      expectedSenderChange -= amount1 + amount2 + txnFee * 2n;
      expectedRecipientChanges[0] += amount1;
      expectedRecipientChanges[1] += amount2;
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          amount1,
          recentBlockhash
        ),
        await createTestTransaction(
          keypair,
          recipients[1].publicKey,
          amount2,
          recentBlockhash
        ),
      ];
      break;
    }

    case 'invalid-bundle-first': {
      const amount1 = BigInt(LAMPORTS_PER_SOL * 0.01);
      const amount2 = BigInt(LAMPORTS_PER_SOL * 0.02);
      expectedSenderChange -= amount1 + amount2 + txnFee * 2n;
      expectedRecipientChanges[0] += amount1;
      expectedRecipientChanges[1] += amount2;
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          amount1,
          '11111111111111111111111111111111' // Stale blockhash
        ),
        await createTestTransaction(
          keypair,
          recipients[1].publicKey,
          amount2,
          recentBlockhash
        ),
      ];
      break;
    }

    case 'invalid-bundle-second': {
      const amount1 = BigInt(LAMPORTS_PER_SOL * 0.01);
      const amount2 = BigInt(LAMPORTS_PER_SOL * 0.02);
      expectedSenderChange -= amount1 + amount2 + txnFee * 2n;
      expectedRecipientChanges[0] += amount1;
      expectedRecipientChanges[1] += amount2;
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          amount1,
          recentBlockhash
        ),
        await createTestTransaction(
          keypair,
          recipients[1].publicKey,
          amount2,
          '11111111111111111111111111111111' // Stale blockhash
        ),
      ];
      break;
    }
  }

  // Sign only the transactions we're going to use
  transactions.forEach((tx) => tx.sign([keypair]));

  // Run the specified test mode
  switch (mode) {
    case 'valid-single':
    case 'invalid-single': {
      console.log(
        `\nTesting sendTransaction with ${
          mode === 'valid-single' ? 'valid' : 'stale'
        } transaction...`
      );
      const response = await sendTransaction(transactions[0]);
      console.log('Waiting for transaction confirmation...');
      await confirmTransaction(connection, response.result);
      break;
    }

    case 'valid-bundle': {
      console.log(`\nTesting sendTransactionBundle with valid transactions...`);
      const bundleResponse = await sendTransactionBundle(transactions);
      console.log('Waiting for transaction bundle confirmation...');
      await Promise.all(
        bundleResponse.result.map((sig) => confirmTransaction(connection, sig))
      );
      break;
    }
    case 'invalid-bundle-first': {
      console.log(
        `\nTesting sendTransactionBundle with first transaction invalid bundle...`
      );
      const bundleResponse = await sendTransactionBundle(transactions);
      console.log(
        `bundleResponse.result.length should be 0: ${
          bundleResponse.result.length === 0
        }`
      );
      break;
    }
    case 'invalid-bundle-second': {
      console.log(
        `\nTesting sendTransactionBundle with second transaction invalid bundle...`
      );
      const bundleResponse = await sendTransactionBundle(transactions);
      console.log(
        `bundleResponse.result.length should be 1: ${
          bundleResponse.result.length === 1
        }`
      );
      console.log('Waiting for transaction bundle confirmation...');
      await Promise.all(
        bundleResponse.result.map((sig) => confirmTransaction(connection, sig))
      );
      break;
    }
  }

  // Check final balances and verify changes
  const senderFinalBalance = await checkBalance(connection, keypair.publicKey);
  const actualSenderChange = senderFinalBalance - senderInitialBalance;

  console.log(`Sender final balance: ${formatSol(senderFinalBalance)}`);
  console.log(`Sender balance change: ${formatSol(actualSenderChange)}`);
  console.log(
    `Expected sender change (including tnsfr fee): ${formatSol(
      expectedSenderChange
    )}`
  );
  console.log(
    `Change matched expected: ${actualSenderChange === expectedSenderChange}`
  );

  await Promise.all(
    recipients.map(async (recipient, i) => {
      const finalBalance = await checkBalance(connection, recipient.publicKey);
      const actualChange = finalBalance - recipientInitialBalances[i];

      console.log(
        `Recipient ${i + 1} final balance: ${formatSol(finalBalance)}`
      );
      console.log(
        `Recipient ${i + 1} balance change: ${formatSol(actualChange)}`
      );
      console.log(
        `Expected recipient ${i + 1} change: ${formatSol(
          expectedRecipientChanges[i]
        )}`
      );
      console.log(
        `Change matched expected: ${
          actualChange === expectedRecipientChanges[i]
        }`
      );
    })
  );

  // Save only the transactions we used
  fs.writeFileSync(
    'test-transactions.json',
    JSON.stringify({
      transactions: transactions.map((tx) => Array.from(tx.serialize())),
      mode,
    })
  );
  console.log('\nSaved transactions to test-transactions.json');
}

async function main() {
  const mode = process.argv[2] as TestMode;

  if (
    !mode ||
    ![
      'valid-single',
      'invalid-single',
      'valid-bundle',
      'invalid-bundle-first',
      'invalid-bundle-second',
    ].includes(mode)
  ) {
    console.error(`Please specify a test mode:
valid-single  - Test sending a single valid transaction
invalid-single - Test sending a single stale transaction
valid-bundle   - Test sending a bundle of valid transactions
invalid-bundle-first - Test sending a bundle of stale transactions with first tx invalid
invalid-bundle-second - Test sending a bundle of stale transactions with second tx invalid
`);
    process.exit(1);
  }

  await runTest(mode);
}

main().catch(console.error);
