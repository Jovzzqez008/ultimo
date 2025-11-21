// graduationHandler.js - FIXED: Usa Price Service mejorado + SOLO MARCA, NO VENDE
import IORedis from 'ioredis';
import { Connection } from '@solana/web3.js';
import { getPriceService } from './priceService.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
});

export class GraduationHandler {
  constructor() {
    this.connection = new Connection(process.env.RPC_URL, 'confirmed');
    this.priceService = getPriceService();
    this.checkInterval = 10000; // Verificar cada 10 segundos

    console.log('🎓 Graduation Handler initialized');
    console.log('   Checking for graduated tokens every 10s');
    console.log('   Using improved Price Service for DEX prices');
    console.log('   MODE: MARKING ONLY - No auto-selling');
  }

  // 🔍 Verificar si un token graduó
  async hasGraduated(mint) {
    try {
      // Si el PriceService expone hasGraduated, úsalo directamente
      if (
        this.priceService &&
        typeof this.priceService.hasGraduated === 'function'
      ) {
        return await this.priceService.hasGraduated(mint);
      }

      // Fallback: inferir graduación desde getPriceWithFallback
      if (
        this.priceService &&
        typeof this.priceService.getPriceWithFallback === 'function'
      ) {
        const priceData = await this.priceService.getPriceWithFallback(mint);
        if (!priceData) return { graduated: false };

        const graduated =
          !!priceData.graduated || priceData.source === 'jupiter_dex';
        const reason = graduated
          ? `source=${priceData.source || 'unknown'}`
          : 'no dex markets';

        return { graduated, reason };
      }

      return { graduated: false };
    } catch (error) {
      console.log(`   ⚠️ Error checking graduation: ${error.message}`);
      return { graduated: false };
    }
  }

  // 💰 Obtener precio en DEX (usa Price Service)
  async getDEXPrice(mint) {
    try {
      console.log(`   🔍 Fetching DEX price...`);

      let priceData = null;

      // 1) Si existe getPriceFromDEX, úsalo
      if (
        this.priceService &&
        typeof this.priceService.getPriceFromDEX === 'function'
      ) {
        priceData = await this.priceService.getPriceFromDEX(mint);
      }
      // 2) Fallback: getPriceWithFallback y usar solo si la fuente es DEX
      else if (
        this.priceService &&
        typeof this.priceService.getPriceWithFallback === 'function'
      ) {
        const data = await this.priceService.getPriceWithFallback(mint);
        if (
          data &&
          data.price &&
          (data.graduated || data.source === 'jupiter_dex')
        ) {
          priceData = data;
        } else {
          console.log(
            `   ⚠️ PriceService fallback is not from DEX (source=${
              data?.source || 'unknown'
            })`
          );
        }
      }

      if (priceData && priceData.price) {
        console.log(`   ✅ DEX price: $${priceData.price.toFixed(10)}`);
        return priceData.price;
      }

      console.log(`   ⚠️ Could not get DEX price`);
      return null;
    } catch (error) {
      console.log(`   ⚠️ Error getting DEX price: ${error.message}`);
      return null;
    }
  }

  // 🚨 Monitorear posiciones abiertas por graduaciones
  async monitorOpenPositions() {
    while (true) {
      try {
        const openPositions = await redis.smembers('open_positions');

        for (const mint of openPositions) {
          const position = await redis.hgetall(`position:${mint}`);

          if (!position || position.strategy !== 'copy') {
            continue;
          }

          // Solo verificar posiciones que compramos en Pump.fun
          if (position.executedDex && position.executedDex !== 'Pump.fun') {
            continue;
          }

          // Skip if already marked as graduated
          if (position.graduated === 'true') {
            continue;
          }

          // Verificar si graduó
          const graduationStatus = await this.hasGraduated(mint);

          if (graduationStatus.graduated) {
            console.log(`\n🎓 GRADUATION DETECTED!`);
            console.log(`   Token: ${mint.slice(0, 8)}...`);
            console.log(`   Wallet: ${position.walletName || 'Unknown'}`);
            console.log(`   Reason: ${graduationStatus.reason}`);
            await this.handleGraduatedPosition(mint, position);
          }
        }

        await new Promise((resolve) =>
          setTimeout(resolve, this.checkInterval)
        );
      } catch (error) {
        console.error('❌ Error monitoring graduations:', error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  // 📄 Manejar posición graduada - SOLO MARCA, NO VENDE
  async handleGraduatedPosition(mint, position) {
    try {
      const entryPrice = parseFloat(position.entryPrice);
      const solAmount = parseFloat(position.solAmount);
      const tokensAmount = parseInt(position.tokensAmount);

      console.log(`\n   📊 Position Analysis:`);
      console.log(`      Entry: $${entryPrice.toFixed(10)}`);
      console.log(`      Amount: ${solAmount.toFixed(4)} SOL`);
      console.log(`      Tokens: ${tokensAmount.toLocaleString()}`);

      // Obtener precio actual en DEX usando Price Service
      const dexPrice = await this.getDEXPrice(mint);

      if (!dexPrice) {
        console.log(`   ⚠️ Could not get DEX price`);
        console.log(
          `   📌 Marking position for tracking with entry price\n`
        );

        await redis.hset(`position:${mint}`, {
          graduated: 'true',
          graduationTime: Date.now().toString(),
          executedDex: 'Jupiter', // Cambiar a Jupiter para ventas futuras
          graduationPrice: entryPrice.toString(), // Usar entry price temporalmente
        });

        // Enviar alerta de Telegram
        if (process.env.TELEGRAM_OWNER_CHAT_ID) {
          const { sendTelegramAlert } = await import('./telegram.js');
          await sendTelegramAlert(
            process.env.TELEGRAM_OWNER_CHAT_ID,
            `🎓 TOKEN GRADUATED\n\n` +
              `Token: ${mint.slice(0, 16)}...\n` +
              `Wallet: ${position.walletName || 'Unknown'}\n` +
              `Entry: $${entryPrice.toFixed(10)}\n` +
              `Amount: ${solAmount.toFixed(4)} SOL\n` +
              `\n` +
              `✅ Token moved to DEX\n` +
              `📊 Tracking continues with your strategies\n` +
              `\n` +
              `Take Profit: +${
                process.env.COPY_PROFIT_TARGET || 200
              }%\n` +
              `Trailing Stop: -${
                process.env.TRAILING_STOP || 35
              }%\n` +
              `Stop Loss: -${process.env.COPY_STOP_LOSS || 45}%`,
            false
          );
        }

        return;
      }

      const pnlPercent = ((dexPrice - entryPrice) / entryPrice) * 100;
      const pnlSOL = (pnlPercent / 100) * solAmount;

      console.log(`\n   💰 Current Status on DEX:`);
      console.log(`      Price: $${dexPrice.toFixed(10)}`);
      console.log(
        `      P&L: ${
          pnlPercent >= 0 ? '+' : ''
        }${pnlPercent.toFixed(2)}%`
      );
      console.log(
        `      SOL: ${
          pnlSOL >= 0 ? '+' : ''
        }${pnlSOL.toFixed(4)} SOL`
      );

      // ✅ SOLO MARCAR COMO GRADUADO, NO AUTO-VENDER
      console.log(
        `\n   📌 Marking as graduated - continuing with your strategies`
      );
      console.log(
        `      TP: +${process.env.COPY_PROFIT_TARGET || 200}%`
      );
      console.log(
        `      TS: -${process.env.TRAILING_STOP || 35}%`
      );
      console.log(
        `      SL: -${process.env.COPY_STOP_LOSS || 45}%`
      );

      await redis.hset(`position:${mint}`, {
        executedDex: 'Jupiter', // Cambiar DEX para ventas
        graduated: 'true',
        graduationPrice: dexPrice.toString(),
        graduationTime: Date.now().toString(),
      });

      console.log(`   ✅ Position updated to track on DEX\n`);

      if (process.env.TELEGRAM_OWNER_CHAT_ID) {
        const { sendTelegramAlert } = await import('./telegram.js');
        await sendTelegramAlert(
          process.env.TELEGRAM_OWNER_CHAT_ID,
          `🎓 TOKEN GRADUATED - TRACKING CONTINUES\n\n` +
            `Token: ${mint.slice(0, 16)}...\n` +
            `Wallet: ${position.walletName || 'Unknown'}\n` +
            `\n` +
            `Entry: $${entryPrice.toFixed(10)} (Pump.fun)\n` +
            `Current: $${dexPrice.toFixed(10)} (DEX)\n` +
            `\n` +
            `💰 P&L: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}%\n` +
            `\n` +
            `📊 Active Strategies:\n` +
            `• Take Profit: +${
              process.env.COPY_PROFIT_TARGET || 200
            }%\n` +
            `• Trailing Stop: -${
              process.env.TRAILING_STOP || 35
            }%\n` +
            `• Stop Loss: -${
              process.env.COPY_STOP_LOSS || 45
            }%\n` +
            `\n` +
            `✅ Bot continues monitoring on DEX`,
          false
        );
      }
    } catch (error) {
      console.error(
        `   ❌ Error handling graduated position: ${error.message}`
      );
    }
  }
}
