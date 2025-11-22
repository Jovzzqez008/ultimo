// pumpPortalExecutor.js - PumpPortal LOCAL Transaction API (0.5% fee)
// ✅ Compatible con CUALQUIER private key en base58
// ✅ Usa Local API (trade-local) para BUY/SELL
// ✅ Validación fuerte de TX: nunca devuelve success=true si on-chain falló
// ✅ Protege contra PnL falsos (tokens / SOL no se movieron)

import axios from 'axios';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

export class PumpPortalExecutor {
  constructor(config = {}) {
    this.rpcUrl = config.RPC_URL;
    this.dryRun = config.DRY_RUN !== 'false';

    if (!this.rpcUrl) {
      throw new Error('PumpPortalExecutor: Missing RPC_URL');
    }
    if (!config.PRIVATE_KEY) {
      throw new Error('PumpPortalExecutor: Missing PRIVATE_KEY');
    }

    const secretKey = bs58.decode(config.PRIVATE_KEY);
    this.wallet = Keypair.fromSecretKey(secretKey);

    this.connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
    });

    // Local API (NO necesita API key, fee fija 0.5%)
    this.baseUrl = 'https://pumpportal.fun/api/trade-local';

    console.log('✅ PumpPortalExecutor initialized (LOCAL API)');
    console.log(`   RPC: ${this.rpcUrl}`);
    console.log(
      `   Wallet: ${this.wallet.publicKey.toBase58().slice(0, 8)}... (dryRun=${
        this.dryRun
      })`,
    );
  }

  // ------------------------------------------------------------------------
  // BUY via Local API
  // ------------------------------------------------------------------------
  async buyToken(mint, solAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log('\n🟦 BUY REQUEST (Local API)');
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Amount: ${solAmount} SOL`);
      console.log(`   Slippage: ${slippage}%`);
      console.log(`   Priority: ${priorityFee} SOL`);

      if (this.dryRun) {
        return this.simulateBuy(mint, solAmount);
      }

      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'buy',
        mint,
        amount: solAmount,
        denominatedInSol: 'true',
        slippage,
        priorityFee,
        pool: 'pump',
      };

      console.log('   📤 Requesting unsigned transaction...');

      const response = await axios.post(this.baseUrl, payload, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.status !== 200 || !response.data) {
        throw new Error(
          `API Error (BUY): status=${response.status} ${response.statusText}`,
        );
      }

      console.log('   ✅ Unsigned transaction received');

      const txBuffer = new Uint8Array(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);

      console.log('   🔐 Signing with your private key...');
      tx.sign([this.wallet]);

      console.log('   📡 Sending to RPC...');

      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      console.log(`   ✅ Transaction sent: ${signature.slice(0, 20)}...`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      // ⏳ Esperar confirmación con verificación de err
      await this.waitForConfirmation(signature);

      // 📦 Obtener detalles on-chain y validar que realmente hubo BUY
      const txDetails = await this.getTxDetails(signature);

      if (!txDetails || txDetails.failed) {
        const reason = txDetails?.error || 'unknown on-chain error';
        throw new Error(`On-chain BUY failed: ${reason}`);
      }

      const tokensReceived = txDetails.tokensReceived ?? 0;
      if (!tokensReceived || tokensReceived <= 0) {
        throw new Error(
          `On-chain BUY has zero tokensReceived (=${tokensReceived}). Treating as failed.`,
        );
      }

      return {
        success: true,
        action: 'buy',
        mint,
        signature,
        solSpent: solAmount,
        tokensReceived,
        timestamp: Date.now(),
        fee: '0.5%',
        api: 'local',
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
  // SELL via Local API
  // ------------------------------------------------------------------------
  async sellToken(mint, amountTokens, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log('\n🟥 SELL REQUEST (Local API)');
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Requested amount (debug): ${amountTokens} tokens`);
      console.log(`   Slippage: ${slippage}%`);
      console.log(`   Priority: ${priorityFee} SOL`);

      if (this.dryRun) {
        return this.simulateSell(mint, amountTokens);
      }

      // Siempre vendemos el 100% de los tokens usando "100%" para evitar desajustes.
      const sellAmountField =
        typeof amountTokens === 'string' && amountTokens.trim().endsWith('%')
          ? amountTokens
          : '100%';

      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: sellAmountField,
        denominatedInSol: 'false',
        slippage,
        priorityFee,
        pool: 'pump',
      };

      console.log('   📤 Requesting unsigned transaction (SELL)...');

      const response = await axios.post(this.baseUrl, payload, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.status !== 200 || !response.data) {
        throw new Error(
          `API Error (SELL): status=${response.status} ${response.statusText}`,
        );
      }

      console.log('   ✅ Unsigned transaction received');

      const txBuffer = new Uint8Array(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);

      console.log('   🔐 Signing with your private key...');
      tx.sign([this.wallet]);

      console.log('   📡 Sending to RPC...');

      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      console.log(`   ✅ Transaction sent: ${signature.slice(0, 20)}...`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      // ⏳ Esperar confirmación con verificación de err
      await this.waitForConfirmation(signature);

      // 📦 Obtener detalles on-chain y validar que realmente hubo SELL
      const txDetails = await this.getTxDetails(signature);

      if (!txDetails || txDetails.failed) {
        const reason = txDetails?.error || 'unknown on-chain error';
        throw new Error(`On-chain SELL failed: ${reason}`);
      }

      const tokensSold =
        txDetails.tokensSold ?? txDetails.tokensReceived ?? 0;
      const solReceived = txDetails.solReceived ?? 0;

      if (!tokensSold || tokensSold <= 0) {
        throw new Error(
          `On-chain SELL has zero tokensSold (=${tokensSold}). Treating as failed.`,
        );
      }
      if (!solReceived || solReceived <= 0) {
        throw new Error(
          `On-chain SELL has zero solReceived (=${solReceived}). Treating as failed.`,
        );
      }

      return {
        success: true,
        action: 'sell',
        mint,
        signature,
        requestedTokens: amountTokens,
        tokensSold,
        solReceived,
        timestamp: Date.now(),
        fee: '0.5%',
        api: 'local',
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
  // HELPERS
  // ------------------------------------------------------------------------
  async waitForConfirmation(signature) {
    console.log('   ⏳ Waiting for confirmation...');

    for (let i = 0; i < 30; i++) {
      try {
        const statusResp = await this.connection.getSignatureStatus(signature);
        const value = statusResp.value;

        if (value) {
          // ❌ Si la TX falló on-chain, lo detectamos aquí
          if (value.err) {
            console.log(
              `   ❌ On-chain error detected in status: ${JSON.stringify(
                value.err,
              )}`,
            );
            throw new Error('Transaction failed on-chain (status.err set)');
          }

          if (
            value.confirmationStatus === 'confirmed' ||
            value.confirmationStatus === 'finalized'
          ) {
            console.log(`   🎉 Confirmed after ${i + 1} attempts`);
            return true;
          }
        }
      } catch (e) {
        console.log(
          `   ⚠️ getSignatureStatus error (attempt ${i + 1}): ${e.message}`,
        );
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.warn('   ⚠️ Confirmation timeout (no explicit success/fail)');
    return false;
  }

  async getTxDetails(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) {
        return {
          failed: true,
          error: 'Transaction not found',
        };
      }

      if (tx.meta && tx.meta.err) {
        return {
          failed: true,
          error: JSON.stringify(tx.meta.err),
          logs: tx.meta.logMessages || [],
        };
      }

      return this.parseTx(tx);
    } catch (err) {
      console.warn(`   ⚠️ Could not fetch tx details: ${err.message}`);
      return {
        failed: true,
        error: err.message,
      };
    }
  }

  parseTx(tx) {
    if (!tx || !tx.meta) {
      return { failed: true, error: 'No meta in transaction' };
    }

    if (tx.meta.err) {
      return {
        failed: true,
        error: JSON.stringify(tx.meta.err),
        logs: tx.meta.logMessages || [],
      };
    }

    let tokensDelta = 0;
    let solDelta = 0;

    // Cambios de tokens (suma de todos los cambios)
    if (tx.meta.postTokenBalances && tx.meta.preTokenBalances) {
      for (const postBal of tx.meta.postTokenBalances) {
        const preBal = tx.meta.preTokenBalances.find(
          (p) => p.accountIndex === postBal.accountIndex,
        );

        const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBal?.uiTokenAmount?.uiAmount || 0;

        tokensDelta += postAmount - preAmount;
      }
    }

    // Cambios de SOL para la wallet de este executor
    if (tx.meta.postBalances && tx.meta.preBalances) {
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
    }

    const tokensReceived = Math.abs(tokensDelta);
    const tokensSold = tokensDelta < 0 ? Math.abs(tokensDelta) : 0;
    const solReceived = solDelta > 0 ? solDelta : 0;

    // ⚠️ Si no hay movimiento de tokens ni de SOL, considerarlo fallo
    if (
      (!tokensReceived || tokensReceived === 0) &&
      (!tokensSold || tokensSold === 0) &&
      (!solReceived || Math.abs(solReceived) < 1e-9)
    ) {
      return {
        failed: true,
        error: 'No token/SOL movement detected for wallet (likely failed tx)',
        raw: {
          tokensDelta,
          solDelta,
        },
      };
    }

    return {
      failed: false,
      tokensReceived,
      tokensSold,
      solReceived,
    };
  }

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
      fee: '0.5%',
      api: 'local',
    };
  }

  simulateSell(mint, amountTokens) {
    // Si viene "100%" no sabemos el balance, devolvemos algo simbólico
    if (typeof amountTokens === 'string' && amountTokens.trim().endsWith('%')) {
      return {
        success: true,
        simulated: true,
        action: 'sell',
        mint,
        tokensSold: amountTokens,
        solReceived: 0,
        signature: this.fakeSignature(),
        timestamp: Date.now(),
        fee: '0.5%',
        api: 'local',
      };
    }

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
      fee: '0.5%',
      api: 'local',
    };
  }

  fakeSignature() {
    const chars = 'abcdef0123456789';
    let sig = '';
    for (let i = 0; i < 88; i++) {
      sig += chars[Math.floor(Math.random() * chars.length)];
    }
    return sig;
  }
}
