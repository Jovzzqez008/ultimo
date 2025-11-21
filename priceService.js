// priceService.js - Servicio de precios unificado con mejor manejo de errores
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { JupiterPriceService } from './jupiterPriceService.js';

// ✅ Program ID CORRECTO de Pump.fun
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkp1KPcLW7jkZo4U9AWhjbnESmtDDMTP');
const PUMP_CURVE_SEED = Buffer.from('bonding-curve');
const PUMP_TOKEN_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1e9;

// DexScreener como fallback remoto
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';

class PriceService {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.connection = new Connection(this.rpcUrl, { commitment: 'confirmed' });

    // Jupiter para graduados / fallback
    this.jupiter = new JupiterPriceService({
      RPC_URL: config.RPC_URL,
      PRIVATE_KEY: config.PRIVATE_KEY,
    });

    // Caches simples
    this.priceCache = new Map(); // mint -> { price, source, ts }
    this.cacheMs = 5000; // 5 seg
    
    // Contador de intentos fallidos por mint (para evitar spam)
    this.failedAttempts = new Map(); // mint -> { count, lastAttempt }
    this.maxFailedAttempts = 3;
    this.failedAttemptsResetMs = 60000; // Reset después de 1 min

    console.log('💵 PriceService initialized');
    console.log(`   RPC: ${this.rpcUrl}`);
    console.log(`   Pump.fun Program ID: ${PUMP_PROGRAM_ID.toBase58()}`);
    console.log(`   Jupiter: lite-api.jup.ag (FREE tier)`);
    console.log(`   DexScreener: Fallback (requires activity)\n`);
  }

  // ------------------------------------------------------------------
  // 🌐 API principal
  // ------------------------------------------------------------------

  /**
   * Obtener precio de un token:
   * - Primero intenta Pump.fun bonding curve (si sigue en Pump.fun)
   * - Si no existe curva o está graduado → usa Jupiter
   * - Si Jupiter falla → intenta DexScreener (requiere que token tenga actividad)
   */
  async getPrice(mintStr, { forceFresh = false } = {}) {
    const mint = new PublicKey(mintStr);
    const now = Date.now();
    const cacheKey = mint.toBase58();

    // Verificar intentos fallidos recientes
    if (!forceFresh && this.failedAttempts.has(cacheKey)) {
      const failed = this.failedAttempts.get(cacheKey);
      
      // Reset si ha pasado suficiente tiempo
      if (now - failed.lastAttempt > this.failedAttemptsResetMs) {
        this.failedAttempts.delete(cacheKey);
      } else if (failed.count >= this.maxFailedAttempts) {
        // Demasiados intentos fallidos, usar cache o devolver null
        if (this.priceCache.has(cacheKey)) {
          const cached = this.priceCache.get(cacheKey);
          console.log(`   ℹ️ Using stale cache for ${cacheKey.slice(0, 8)}... (too many failures)`);
          return cached;
        }
        
        console.log(`   ⏭️ Skipping price check for ${cacheKey.slice(0, 8)}... (too many failures, retry in ${Math.floor((this.failedAttemptsResetMs - (now - failed.lastAttempt))/1000)}s)`);
        return {
          mint: cacheKey,
          price: null,
          source: 'skipped',
          error: 'Too many failed attempts',
          ts: now,
        };
      }
    }

    // Cache normal
    if (!forceFresh && this.priceCache.has(cacheKey)) {
      const cached = this.priceCache.get(cacheKey);
      if (now - cached.ts < this.cacheMs) {
        return cached;
      }
    }

    // 1) Intentar Pump.fun bonding curve
    try {
      const pump = await this.getPumpFunPrice(mint);
      if (pump && pump.price && !pump.graduated) {
        const result = {
          mint: cacheKey,
          price: pump.price,
          source: 'pump.fun',
          bondingProgress: pump.bondingProgress,
          graduated: false,
          ts: now,
        };
        this.priceCache.set(cacheKey, result);
        this.resetFailedAttempts(cacheKey); // Éxito, reset contador
        return result;
      }

      // Si la curva marca "complete" o no existe → considerar graduado
      if (pump && pump.graduated) {
        console.log(`   🎓 ${cacheKey.slice(0, 8)}... marked as graduated by bonding curve`);
      }
    } catch (err) {
      // Ignoramos errores de bonding curve para no ensuciar logs
    }

    // 2) Intentar Jupiter (graduado o no se pudo leer la curva)
    const jup = await this.getPriceForGraduated(cacheKey);
    if (jup && jup.price) {
      const result = {
        mint: cacheKey,
        price: jup.price,
        source: jup.source || 'jupiter',
        bondingProgress: null,
        graduated: true,
        ts: now,
      };
      this.priceCache.set(cacheKey, result);
      this.resetFailedAttempts(cacheKey); // Éxito, reset contador
      return result;
    }

    // 3) Último fallback: DexScreener (solo si token tiene actividad)
    const dex = await this.getPriceFromDexScreener(cacheKey);
    if (dex && dex.price) {
      const result = {
        mint: cacheKey,
        price: dex.price,
        source: 'dexscreener',
        bondingProgress: null,
        graduated: true,
        ts: now,
      };
      this.priceCache.set(cacheKey, result);
      this.resetFailedAttempts(cacheKey); // Éxito, reset contador
      return result;
    }

    // ❌ Todos los métodos fallaron
    this.recordFailedAttempt(cacheKey);
    
    // Usar cache antiguo si existe
    if (this.priceCache.has(cacheKey)) {
      const cached = this.priceCache.get(cacheKey);
      console.log(`   ⚠️ All price sources failed, using stale cache (${Math.floor((now - cached.ts)/1000)}s old)`);
      return {
        ...cached,
        stale: true
      };
    }

    return {
      mint: cacheKey,
      price: null,
      source: 'none',
      bondingProgress: null,
      graduated: false,
      ts: now,
      error: 'No price source available',
    };
  }

  /**
   * Forzar uso de Jupiter para tokens graduados
   */
  async getPriceForGraduated(mintStr) {
    try {
      const jup = await this.jupiter.getPrice(mintStr, true);
      if (jup && jup.price) {
        return {
          price: jup.price,
          source: jup.source || 'jupiter',
        };
      }
      return { price: null, source: 'jupiter', error: jup?.error };
    } catch (err) {
      // Solo log en caso de error inesperado
      if (!err.message.includes('Route not found') && !err.message.includes('404')) {
        console.error(`   ❌ Jupiter getPriceForGraduated error: ${err.message}`);
      }
      return { price: null, source: 'jupiter', error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // 🧮 Pump.fun bonding curve
  // ------------------------------------------------------------------

  /**
   * Derivar PDA de la bonding curve
   */
  findBondingCurveAddress(tokenMint) {
    const [curveAddress] = PublicKey.findProgramAddressSync(
      [PUMP_CURVE_SEED, tokenMint.toBuffer()],
      PUMP_PROGRAM_ID
    );
    return curveAddress;
  }

  /**
   * Leer el estado de la bonding curve + calcular precio + progreso
   */
  async getPumpFunPrice(tokenMint) {
    const curveAddress = this.findBondingCurveAddress(tokenMint);

    try {
      const accountInfo = await this.connection.getAccountInfo(curveAddress);
      
      if (!accountInfo || !accountInfo.data) {
        // ✅ Silencio: Devolvemos null en lugar de lanzar Error
        return null;
      }

      const data = accountInfo.data;

      // Opcional: verificar signature (primeros 8 bytes)
      const expectedSig = Buffer.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
      const actualSig = data.subarray(0, 8);
      if (!actualSig.equals(expectedSig)) {
        console.warn('   ⚠️ Bonding curve account signature mismatch (IDL discriminator)');
      }

      // Layout según el IDL
      const virtualTokenReserves = data.readBigUInt64LE(0x08);
      const virtualSolReserves = data.readBigUInt64LE(0x10);
      const realTokenReserves = data.readBigUInt64LE(0x18);
      const realSolReserves = data.readBigUInt64LE(0x20);
      const tokenTotalSupply = data.readBigUInt64LE(0x28);
      const complete = data.readUInt8(0x30) !== 0;

      if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n) {
        throw new Error('Invalid bonding curve state (zero reserves)');
      }

      const virtualSol = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
      const virtualTokens = Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS;

      const price = virtualSol / virtualTokens;

      // Progreso de bonding
      const INITIAL_REAL_TOKEN_RESERVES = 793100000000000n;
      let bondingProgress = 0;
      if (realTokenReserves < INITIAL_REAL_TOKEN_RESERVES) {
        bondingProgress =
          1 -
          Number((realTokenReserves * 10000n) / INITIAL_REAL_TOKEN_RESERVES) /
            10000;
      }

      return {
        price,
        curveState: {
          virtualTokenReserves: virtualTokenReserves.toString(),
          virtualSolReserves: virtualSolReserves.toString(),
          realTokenReserves: realTokenReserves.toString(),
          realSolReserves: realSolReserves.toString(),
          tokenTotalSupply: tokenTotalSupply.toString(),
          complete,
        },
        bondingProgress,
        graduated: complete,
      };
    } catch (e) {
      // Cualquier otro error de red o parseo devuelve null suavemente
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 🔄 Fallback: DexScreener (por si Jupiter falla)
  // ------------------------------------------------------------------
  async getPriceFromDexScreener(mintStr) {
    try {
      const url = `${DEXSCREENER_URL}/${mintStr}`;
      const res = await fetch(url, { 
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (!res.ok) {
        if (res.status === 404) {
          // Token no encontrado - normal para tokens nuevos
          return { price: null, error: 'Token not listed on DexScreener yet' };
        }
        throw new Error(`DexScreener HTTP ${res.status}`);
      }
      
      const data = await res.json();
      
      if (!data.pairs || !data.pairs.length) {
        // ✅ Mejorado: No lanzar error, devolver null con mensaje informativo
        console.log(`   ℹ️ ${mintStr.slice(0, 8)}... not on DexScreener (needs first trade)`);
        return { 
          price: null, 
          error: 'No pairs - token needs trading activity to be listed' 
        };
      }

      // Tomar el par con más liquidez
      const best = data.pairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];

      const price = Number(best.priceNative || best.priceUsd || 0);
      if (!price || !Number.isFinite(price)) {
        throw new Error('Invalid DexScreener price');
      }

      console.log(
        `   📊 DexScreener price for ${mintStr.slice(0, 8)}...: ${price} (source: ${best.dexId})`
      );

      return { price, source: 'dexscreener' };
    } catch (err) {
      // ✅ Solo log de warnings, no errores
      if (!err.message.includes('No pairs')) {
        console.warn(`   ⚠️ DexScreener unavailable: ${err.message.split('\n')[0]}`);
      }
      return { price: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Gestión de intentos fallidos
  // ------------------------------------------------------------------
  
  recordFailedAttempt(mintStr) {
    const now = Date.now();
    const current = this.failedAttempts.get(mintStr) || { count: 0, lastAttempt: 0 };
    
    this.failedAttempts.set(mintStr, {
      count: current.count + 1,
      lastAttempt: now
    });
  }
  
  resetFailedAttempts(mintStr) {
    this.failedAttempts.delete(mintStr);
  }

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------

  /**
   * Calcular valor actual (en SOL) dada una posición y el precio
   */
  calculateCurrentValue(tokensAmount, price) {
    const amount = typeof tokensAmount === 'number'
      ? tokensAmount
      : Number(tokensAmount);
    return amount * price;
  }
  
  /**
   * Verificar si un token tiene precio disponible
   */
  async hasPriceAvailable(mintStr) {
    const priceData = await this.getPrice(mintStr);
    return !!(priceData && priceData.price && priceData.source !== 'none');
  }
  
  /**
   * Limpiar cache (útil para testing o cuando se necesita forzar refresh)
   */
  clearCache() {
    this.priceCache.clear();
    this.failedAttempts.clear();
    console.log('   🧹 Price cache cleared');
  }
}

// Singleton para mantener compatibilidad con tu bot actual
let _singleton = null;

export function getPriceService() {
  if (!_singleton) {
    const config = {
      RPC_URL: process.env.RPC_URL,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
    };
    _singleton = new PriceService(config);
  }
  return _singleton;
}
