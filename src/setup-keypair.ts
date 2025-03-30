import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const PUBLIC_DEVNET_RPC = process.env.PUBLIC_DEVNET_RPC;

async function setupKeypair(): Promise<void> {
  if (!PUBLIC_DEVNET_RPC) {
    console.error('RPC_URL is not set');
    return;
  }

  let keypair: Keypair;
  if (fs.existsSync('keypair.json')) {
    console.log('Keypair already exists. Loading existing keypair...');
    const keypairData = JSON.parse(fs.readFileSync('keypair.json', 'utf-8'));
    keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    console.log('Loaded public key:', keypair.publicKey.toString());
  } else {
    // Generate new keypair if none exists
    keypair = Keypair.generate();

    fs.writeFileSync(
      'keypair.json',
      `[${Buffer.from(keypair.secretKey.toString())}]`
    );

    fs.writeFileSync('public-key.txt', keypair.publicKey.toString());

    console.log('New keypair generated and saved');
    console.log('Public key:', keypair.publicKey.toString());
  }

  const devnetConnection = new Connection(PUBLIC_DEVNET_RPC);
  const balance = await devnetConnection.getBalance(keypair.publicKey);
  console.log('Balance before airdrop:', balance);

  // Use public devnet not helius for airdrop
  try {
    const airdropSignature = await devnetConnection.requestAirdrop(
      keypair.publicKey,
      LAMPORTS_PER_SOL * 2
    );

    // Using the newer confirmation strategy
    const latestBlockhash = await devnetConnection.getLatestBlockhash();
    await devnetConnection.confirmTransaction({
      signature: airdropSignature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    const balanceAfter = await devnetConnection.getBalance(keypair.publicKey);
    console.log('Balance after:', balanceAfter);
  } catch (error) {
    console.error('Error requesting airdrop:', error);
  }
}

setupKeypair().catch(console.error);
