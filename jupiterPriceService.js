// jupiterPriceService.js - CORREGIDO: API V1 (api.jup.ag) + RETRIES
import fetch from "node-fetch";
import {
  Connection,
  VersionedTransaction,
  Keypair,
  SendTransactionError
} from "@solana/web3.js";
import bs58 from "bs58";

// Helper para reintentos automáticos
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export class JupiterPriceService {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.connection = new Connection(this.rpcUrl, {
      commitment: "confirmed"
    });

    // Private key (para firmar swaps)
    try {
      const decoded = Array.isArray(config.PRIVATE_KEY)
        ? Uint8Array.from(config.PRIVATE_KEY)
        : bs58.decode(config.PRIVATE_KEY);

      this.wallet = Keypair.fromSecretKey(decoded);
    } catch (err) {
      console.error("❌ JupiterPriceService INVALID PRIVATE KEY:", err.message);
      throw err;
    }

    // Cache
    this.priceCache = new Map();
    this.cacheMaxAge = 5000; // 5s
    
    // ✅ URLs ACTUALIZADAS a la nueva API V1 estable
    this.jupiterQuoteURL = "https://api.jup.ag/swap/v1/quote";
    this.jupiterSwapURL = "https://api.jup.ag/swap/v1/swap";

    console.log("🪐 JupiterPriceService READY (API V1)");
  }

  // ------------------------------------------------------------------------
  // 🎓 1. Detectar si un token está graduado
  // ------------------------------------------------------------------------
  async isGraduated(mint) {
    try {
      const pumpProgramId = new PublicKey(
        "6EF8rrecthR5Dkp1KPcLW7jkZo4U9AWhjbnESmtDDMTP"
      );

      const accounts = await this.connection.getProgramAccounts(pumpProgramId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: mint
            }
          }
        ]
      });

      if (accounts.length === 0) {
        console.log(`🎓 Token ${mint.slice(0, 8)}... GRADUADO`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn("⚠️ Graduation check failed:", err.message);
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // 💰 2. Obtener precio del token (Jupiter)
  // ------------------------------------------------------------------------
  async getPrice(mint, forceFresh = false) {
    try {
      const now = Date.now();

      // Cache
      if (!forceFresh && this.priceCache.has(mint)) {
        const old = this.priceCache.get(mint);
        if (now - old.timestamp < this.cacheMaxAge) {
          return { price: old.price, source: "cache" };
        }
      }

      const SOL = "So11111111111111111111111111111111111111112";

      // Usamos la nueva URL y swapMode=ExactIn para asegurar compatibilidad
      const url = `${this.jupiterQuoteURL}?inputMint=${mint}&outputMint=${SOL}&amount=1000000&swapMode=ExactIn&slippageBps=50`;

      const data = await fetchWithRetry(url);

      if (!data.outAmount) throw new Error("Quote has no outAmount");

      const price = Number(data.outAmount) / 1_000_000;

      this.priceCache.set(mint, {
        price,
        timestamp: now,
        outAmount: data.outAmount
      });

      return { price, source: "jupiter" };
    } catch (err) {
      // Log menos agresivo para errores de red comunes
      if (err.message.includes('ENOTFOUND') || err.message.includes('fetch failed')) {
        console.warn(`⚠️ Jupiter Connection Issue: ${err.message}`);
      } else {
        console.error("❌ Jupiter getPrice failed:", err.message);
      }

      if (this.priceCache.has(mint)) {
        return {
          price: this.priceCache.get(mint).price,
          source: "cache-fallback"
        };
      }

      return { price: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------------
  // 🔄 3. Ejecutar Swap Ultra para vender tokens graduados
  // ------------------------------------------------------------------------
  async swapToken(mint, tokenAmount, slippageBps = 500) {
    try {
      console.log("\n🪐 JUPITER ULTRA SWAP V1");
      console.log(" Mint:", mint);
      console.log(" Tokens:", tokenAmount);
      console.log(` Slippage: ${slippageBps / 100}%`);

      const inputMint = mint;
      const outputMint = "So11111111111111111111111111111111111111112"; // SOL
      const amount = Math.floor(tokenAmount);

      // Paso 1: obtener quote (Retry incluido)
      const quoteURL = `${this.jupiterQuoteURL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

      const quoteResponse = await fetchWithRetry(quoteURL);

      if (!quoteResponse.outAmount) {
        throw new Error("Jupiter quote failed");
      }

      console.log(
        ` Expected SOL: ${(Number(quoteResponse.outAmount) / 1e9).toFixed(4)} SOL`
      );

      // Paso 2: Swap instructions (Retry incluido)
      // ✅ API V1 usa 'quoteResponse' en lugar de 'quote'
      const swapData = await fetchWithRetry(this.jupiterSwapURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quoteResponse,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true
        })
      });

      if (!swapData.swapTransaction) {
        throw new Error("Jupiter swap API returned no transaction");
      }

      // Paso 3: Construir transacción
      const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
      const swapTx = VersionedTransaction.deserialize(swapTxBuf);

      swapTx.sign([this.wallet]);

      // Paso 4: Enviar transacción
      let signature;
      try {
        signature = await this.connection.sendTransaction(swapTx, {
          skipPreflight: false,
          maxRetries: 3
        });
      } catch (err) {
        if (err instanceof SendTransactionError) {
          console.error("Jupiter transaction error logs:", err.logs);
        }
        throw err;
      }

      console.log(" ✔ Swap signature:", signature);

      return {
        success: true,
        action: "sell",
        signature,
        solReceived: Number(quoteResponse.outAmount) / 1e9,
        expectedSOL: Number(quoteResponse.outAmount) / 1e9,
        priceImpact: quoteResponse.priceImpact,
        tokenAmount
      };
    } catch (err) {
      console.error("❌ Jupiter swapToken error:", err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }
}
