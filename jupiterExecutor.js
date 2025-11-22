// jupiterExecutor.js – Jupiter Ultra Swap EXECUTOR (vende tokens → SOL)
// Usa Jupiter Lite API (v6) + tu propia wallet/ RPC
//
// Uso típico:
//
//   import { JupiterExecutor } from './jupiterExecutor.js';
//
//   const jupiter = new JupiterExecutor({
//     RPC_URL: process.env.RPC_URL,
//     PRIVATE_KEY: process.env.PRIVATE_KEY,
//     DRY_RUN: process.env.DRY_RUN,
//   });
//
//   const result = await jupiter.swapToken(mint, uiTokenAmount, 500); // 500 = 5% slippage
//
//   if (result.success) { ... }
//
// Este executor está pensado para usarse cuando el token YA ESTÁ GRADUADO.

import axios from 'axios';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';

export class JupiterExecutor {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.dryRun = config.DRY_RUN !== 'false';

    const secretKey = bs58.decode(config.PRIVATE_KEY);
    this.wallet = Keypair.fromSecretKey(secretKey);

    this.connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 3,
    });

    this.quoteUrl = 'https://quote-api.jup.ag/v6/quote';
    this.swapUrl = 'https://quote-api.jup.ag/v6/swap';

    // SOL mint (wrapped SOL en Jupiter)
    this.SOL_MINT = 'So11111111111111111111111111111111111111112';

    console.log('🪐 JupiterExecutor initialized');
    console.log(`   Wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`   Mode: ${this.dryRun ? '📄 PAPER' : '💰 LIVE'}`);
  }

  // ------------------------------------------------------------------------
  // Helpers básicos
  // ------------------------------------------------------------------------

  async getTokenDecimals(mint) {
    try {
      const info = await this.connection.getParsedAccountInfo(
        new PublicKey(mint),
      );
      const data = info.value?.data;
      const parsed = data?.parsed;
      const decimals = parsed?.info?.decimals;

      if (typeof decimals === 'number') {
        return decimals;
      }

      console.warn(
        `⚠️ Could not detect decimals for ${mint.slice(0, 8)}..., fallback 6`,
      );
      return 6;
    } catch (err) {
      console.warn(
        `⚠️ Error fetching decimals for ${mint.slice(0, 8)}...: ${err.message}`,
      );
      return 6;
    }
  }

  async waitForConfirmation(signature) {
    console.log('   ⏳ Waiting for confirmation (Jupiter swap)...');

    for (let i = 0; i < 30; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          console.log(`   🎉 Confirmed after ${i + 1} attempts`);
          return true;
        }
      } catch (e) {
        // ignorar errores temporales
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.warn('   ⚠️ Confirmation timeout (may still succeed)');
    return false;
  }

  async parseSwapTx(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.meta) return { solReceived: 0 };

      let solDelta = 0;
      const walletPubkey = this.wallet.publicKey.toBase58();

      const staticKeys = tx.transaction.message.staticAccountKeys;
      const legacyKeys = tx.transaction.message.accountKeys;

      let walletIndex = -1;

      if (Array.isArray(staticKeys) && staticKeys.length > 0) {
        walletIndex = staticKeys.findIndex(
          (k) => k.toBase58 && k.toBase58() === walletPubkey,
        );
      }

      if (walletIndex === -1 && Array.isArray(legacyKeys)) {
        walletIndex = legacyKeys.findIndex(
          (k) => k.toBase58 && k.toBase58() === walletPubkey,
        );
      }

      if (walletIndex >= 0) {
        const preSOL = (tx.meta.preBalances[walletIndex] || 0) / 1e9;
        const postSOL = (tx.meta.postBalances[walletIndex] || 0) / 1e9;
        solDelta = postSOL - preSOL;
      }

      return { solReceived: solDelta };
    } catch (err) {
      console.warn(`   ⚠️ Could not parse swap tx: ${err.message}`);
      return { solReceived: 0 };
    }
  }

  // ------------------------------------------------------------------------
  // Obtener QUOTE de Jupiter (tokens -> SOL)
  // ------------------------------------------------------------------------
  async getSwapQuote(mint, uiTokenAmount, slippageBps = 500) {
    if (!uiTokenAmount || uiTokenAmount <= 0) {
      throw new Error('Invalid token amount for quote');
    }

    const decimals = await this.getTokenDecimals(mint);
    const factor = 10 ** decimals;
    const baseUnits = BigInt(Math.floor(uiTokenAmount * factor));

    console.log('🪐 JUPITER ULTRA SWAP (quote)');
    console.log(`   Mint: ${mint.slice(0, 8)}...`);
    console.log(`   Tokens (UI): ${uiTokenAmount}`);
    console.log(`   Decimals detectados: ${decimals}`);
    console.log(`   Amount (base units): ${baseUnits.toString()}`);
    console.log(`   Slippage: ${(slippageBps / 100).toFixed(2)}%`);

    const params = {
      inputMint: mint,
      outputMint: this.SOL_MINT,
      amount: baseUnits.toString(),
      slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    };

    const response = await axios.get(this.quoteUrl, { params });

    if (!response.data || !response.data.outAmount) {
      throw new Error('Quote: Jupiter did not return outAmount');
    }

    const outAmountLamports = BigInt(response.data.outAmount);
    const expectedSOL = Number(outAmountLamports) / 1e9;

    console.log(`   Expected SOL: ${expectedSOL.toFixed(8)} SOL`);

    return {
      decimals,
      baseUnits,
      expectedSOL,
      quoteResponse: response.data,
    };
  }

  // ------------------------------------------------------------------------
  // SWAP: vende tokens → SOL usando Jupiter
  // ------------------------------------------------------------------------
  async swapToken(mint, uiTokenAmount, slippageBps = 500) {
    try {
      console.log('\n🪐 JUPITER ULTRA SWAP (lite-api)');
      console.log(`   Mint: ${mint.slice(0, 8)}...`);
      console.log(`   Tokens (UI): ${uiTokenAmount}`);
      console.log(`   Slippage: ${(slippageBps / 100).toFixed(2)}%`);

      if (this.dryRun) {
        // Simulación sencilla sin tocar red
        return {
          success: true,
          simulated: true,
          mint,
          tokensSold: uiTokenAmount,
          expectedSOL: 0,
          solReceived: 0,
          signature: this.fakeSignature(),
        };
      }

      // 1) Obtener quote
      const { decimals, baseUnits, expectedSOL, quoteResponse } =
        await this.getSwapQuote(mint, uiTokenAmount, slippageBps);

      // 2) Solicitar transacción de swap a Jupiter
      const swapRequest = {
        quoteResponse,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      };

      const swapRes = await axios.post(this.swapUrl, swapRequest, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!swapRes.data || !swapRes.data.swapTransaction) {
        throw new Error('Jupiter did not return swapTransaction');
      }

      const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(swapTxBuf);

      console.log('   🔐 Signing Jupiter swap tx with your private key...');
      tx.sign([this.wallet]);

      console.log('   📡 Sending swap transaction to RPC...');

      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      console.log(`   ✅ Swap tx sent: ${signature.slice(0, 20)}...`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      // 3) Esperar confirmación y calcular SOL recibido
      await this.waitForConfirmation(signature);
      const { solReceived } = await this.parseSwapTx(signature);

      console.log('   ✅ Swap completed via Jupiter');
      console.log(`   Expected SOL: ${expectedSOL.toFixed(8)} SOL`);
      console.log(`   SOL received (parsed): ${solReceived.toFixed(8)} SOL`);

      return {
        success: true,
        action: 'sell',
        mint,
        signature,
        decimals,
        tokensSold: uiTokenAmount,
        baseUnits: baseUnits.toString(),
        expectedSOL,
        solReceived,
        timestamp: Date.now(),
        api: 'jupiter',
      };
    } catch (err) {
      console.error(`❌ JUPITER SWAP FAILED: ${err.message}`);
      return {
        success: false,
        action: 'sell',
        mint,
        error: err.message,
      };
    }
  }

  // ------------------------------------------------------------------------
  // Utilidades varias
  // ------------------------------------------------------------------------
  fakeSignature() {
    const arr = new Uint8Array(64).map(() =>
      Math.floor(Math.random() * 256),
    );
    return bs58.encode(arr);
  }
}
