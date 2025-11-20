// pumpPortalExecutor.js – PumpPortal Lightning API Integration
// Compatible con PRIVATE_KEY en base58 y tu arquitectura actual

import axios from 'axios';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
} from '@solana/web3.js';

export class PumpPortalExecutor {
  constructor(config) {
    this.apiKey = config.PUMPPORTAL_API_KEY;
    this.rpcUrl = config.RPC_URL;
    this.dryRun = config.DRY_RUN !== 'false';

    // PRIVATE_KEY en BASE58 (tu formato actual)
    const secretKey = bs58.decode(config.PRIVATE_KEY);
    this.wallet = Keypair.fromSecretKey(secretKey);

    this.connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed'
    });

    this.baseUrl = 'https://pumpportal.fun/api';

    console.log(`🔷 PumpPortal Executor Loaded`);
    console.log(` Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(` Mode: ${this.dryRun ? '📄 PAPER' : '💰 LIVE'}`);
  }

  // ------------------------------------------------------------------------
  // BUY
  // ------------------------------------------------------------------------
  async buyToken(mint, solAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟦 BUY REQUEST`);
      console.log(` Mint: ${mint.slice(0, 12)}...`);
      console.log(` Amount: ${solAmount} SOL`);
      console.log(` Slippage: ${slippage}%`);
      console.log(` Priority: ${priorityFee} SOL`);

      if (this.dryRun) {
        return this.simulateBuy(mint, solAmount);
      }

      const payload = {
        action: 'buy',
        mint,
        amount: solAmount,
        denominatedInSol: 'true',
        slippage,
        priorityFee,
        pool: 'pump',
        skipPreflight: false,
        jitoOnly: false,
      };

      const response = await axios.post(
        `${this.baseUrl}/trade?api-key=${this.apiKey}`,
        payload,
        { timeout: 30000 }
      );

      if (response.status !== 200 || !response.data) {
        throw new Error(`API Error: ${response.data?.error || 'Unknown'}`);
      }

      const signature = response.data.signature;
      console.log(`✅ BUY Sent`);
      console.log(` Signature: ${signature.slice(0, 20)}...`);

      await this.waitForConfirmation(signature);
      const tx = await this.getTxDetails(signature);

      return {
        success: true,
        action: 'buy',
        mint,
        signature,
        solSpent: solAmount,
        tokensReceived: tx?.tokensReceived || 0,
        timestamp: Date.now(),
      };

    } catch (err) {
      console.error(`❌ BUY FAILED: ${err.message}`);
      return {
        success: false,
        action: 'buy',
        mint,
        error: err.message,
      };
    }
  }

  // ------------------------------------------------------------------------
  // SELL
  // ------------------------------------------------------------------------
  async sellToken(mint, amountTokens, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟥 SELL REQUEST`);
      console.log(` Mint: ${mint.slice(0, 12)}...`);
      console.log(` Amount: ${amountTokens}`);
      console.log(` Slippage: ${slippage}%`);

      if (this.dryRun) {
        return this.simulateSell(mint, amountTokens);
      }

      const payload = {
        action: 'sell',
        mint,
        amount: amountTokens,
        denominatedInSol: 'false',
        slippage,
        priorityFee,
        pool: 'pump',
        skipPreflight: false,
        jitoOnly: false,
      };

      const response = await axios.post(
        `${this.baseUrl}/trade?api-key=${this.apiKey}`,
        payload,
        { timeout: 30000 }
      );

      if (response.status !== 200 || !response.data) {
        throw new Error(`API Error: ${response.data?.error || 'Unknown'}`);
      }

      const signature = response.data.signature;
      console.log(`✅ SELL Sent`);
      console.log(` Signature: ${signature.slice(0, 20)}...`);

      await this.waitForConfirmation(signature);
      const tx = await this.getTxDetails(signature);

      return {
        success: true,
        action: 'sell',
        mint,
        signature,
        tokensSold: amountTokens,
        solReceived: tx?.solReceived || 0,
        timestamp: Date.now(),
      };

    } catch (err) {
      console.error(`❌ SELL FAILED: ${err.message}`);
      return {
        success: false,
        action: 'sell',
        mint,
        error: err.message,
      };
    }
  }

  // ------------------------------------------------------------------------
  // DRY RUN SIMULATIONS
  // ------------------------------------------------------------------------
  simulateBuy(mint, solAmount) {
    const avgPrice = 0.000001;
    const tokens = solAmount / avgPrice;

    return {
      success: true,
      simulated: true,
      action: 'buy',
      mint,
      solSpent: solAmount,
      tokensReceived: tokens,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
    };
  }

  simulateSell(mint, amountTokens) {
    const avgPrice = 0.000001;
    const sol = amountTokens * avgPrice;

    return {
      success: true,
      simulated: true,
      action: 'sell',
      mint,
      tokensSold: amountTokens,
      solReceived: sol,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
    };
  }

  // ------------------------------------------------------------------------
  // HELPERS
  // ------------------------------------------------------------------------
  async waitForConfirmation(signature) {
    for (let i = 0; i < 30; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          console.log(`  🎉 Confirmed after ${i} attempts`);
          return true;
        }
      } catch (e) {}

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.warn(`  ⚠️ Confirmation timeout`);
    return false;
  }

  async getTxDetails(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      return this.parseTx(tx);
    } catch {
      return null;
    }
  }

  parseTx(tx) {
    if (!tx) return {};

    let tokensReceived = 0;
    let solReceived = 0;

    if (tx.meta?.postTokenBalances && tx.meta?.preTokenBalances) {
      const before =
        tx.meta.preTokenBalances[0]?.uiTokenAmount?.uiAmount ?? 0;
      const after =
        tx.meta.postTokenBalances[0]?.uiTokenAmount?.uiAmount ?? 0;

      tokensReceived = after - before;
    }

    if (tx.meta?.postBalances && tx.meta?.preBalances) {
      const walletIndex = tx.transaction.message.accountKeys.findIndex(
        (k) => k.toBase58() === this.wallet.publicKey.toBase58()
      );

      if (walletIndex >= 0) {
        const before = tx.meta.preBalances[walletIndex] / 1e9;
        const after = tx.meta.postBalances[walletIndex] / 1e9;
        solReceived = after - before;
      }
    }

    return {
      tokensReceived,
      solReceived,
    };
  }

  fakeSignature() {
    const arr = new Uint8Array(64).map(() =>
      Math.floor(Math.random() * 256)
    );
    return bs58.encode(arr);
  }
}
