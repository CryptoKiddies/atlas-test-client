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
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const ATLAS_SERVICE_URL = process.env.ATLAS_SERVICE_URL;

type TestMode =
  | 'valid-single'
  | 'invalid-single'
  | 'valid-bundle'
  | 'invalid-bundle';

async function loadKeypair(): Promise<Keypair> {
  const keypairData = JSON.parse(fs.readFileSync('keypair.json', 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

async function createTestTransaction(
  fromKeypair: Keypair,
  toPubkey: PublicKey,
  amount: number,
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

async function sendTransaction(tx: VersionedTransaction) {
  const serializedTx = Array.from(tx.serialize());
  try {
    const response = await axios.post(`${ATLAS_SERVICE_URL}/sendTransaction`, {
      transaction: serializedTx,
    });
    console.log('Transaction sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending transaction:', error);
    throw error;
  }
}

async function sendTransactionBundle(txs: VersionedTransaction[]) {
  const serializedTxs = txs.map((tx) => Array.from(tx.serialize()));
  try {
    const response = await axios.post(
      `${ATLAS_SERVICE_URL}/sendTransactionBundle`,
      {
        transactions: serializedTxs,
      }
    );
    console.log('Transaction bundle sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending transaction bundle:', error);
    throw error;
  }
}

async function runTest(mode: TestMode) {
  // Load our keypair
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

  // Create and sign only the transactions needed for this test
  let transactions: VersionedTransaction[] = [];

  switch (mode) {
    case 'valid-single':
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          LAMPORTS_PER_SOL * 0.1,
          '11111111111111111111111111111111'
        ),
      ];
      break;

    case 'invalid-single':
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          LAMPORTS_PER_SOL * 0.1,
          '11111111111111111111111111111111'
        ),
      ];
      break;

    case 'valid-bundle':
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          LAMPORTS_PER_SOL * 0.1,
          '11111111111111111111111111111111'
        ),
        await createTestTransaction(
          keypair,
          recipients[1].publicKey,
          LAMPORTS_PER_SOL * 0.15,
          '11111111111111111111111111111111'
        ),
      ];
      break;

    case 'invalid-bundle':
      transactions = [
        await createTestTransaction(
          keypair,
          recipients[0].publicKey,
          LAMPORTS_PER_SOL * 0.1,
          '11111111111111111111111111111111'
        ),
        await createTestTransaction(
          keypair,
          recipients[1].publicKey,
          LAMPORTS_PER_SOL * 0.15,
          '11111111111111111111111111111111'
        ),
      ];
      break;
  }

  // Sign only the transactions we're going to use
  transactions.forEach((tx) => tx.sign([keypair]));

  // Run the specified test mode
  switch (mode) {
    case 'valid-single':
    case 'invalid-single':
      console.log(
        `\nTesting sendTransaction with ${
          mode === 'valid-single' ? 'valid' : 'stale'
        } transaction...`
      );
      await sendTransaction(transactions[0]);
      break;

    case 'valid-bundle':
    case 'invalid-bundle':
      console.log(
        `\nTesting sendTransactionBundle with ${
          mode === 'valid-bundle' ? 'valid' : 'stale'
        } transactions...`
      );
      await sendTransactionBundle(transactions);
      break;
  }

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
      'invalid-bundle',
    ].includes(mode)
  ) {
    console.error('Please specify a test mode:');
    console.error('  valid-single  - Test sending a single valid transaction');
    console.error('  invalid-single - Test sending a single stale transaction');
    console.error(
      '  valid-bundle   - Test sending a bundle of valid transactions'
    );
    console.error(
      '  invalid-bundle - Test sending a bundle of stale transactions'
    );
    process.exit(1);
  }

  await runTest(mode);
}

main().catch(console.error);
