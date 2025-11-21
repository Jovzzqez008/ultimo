// copyStrategy.js - Estrategia de copy trading con anti-recompra y salidas dinámicas
import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
});

export class CopyStrategy {
  constructor() {
    // 📥 Parámetros de entrada (copy)
    this.minWalletsToBuy = parseInt(process.env.MIN_WALLETS_TO_BUY || '1', 10);
    this.minWalletsToSell = parseInt(process.env.MIN_WALLETS_TO_SELL || '1', 10);

    // 💰 Take Profit
    this.takeProfitEnabled = process.env.COPY_PROFIT_TARGET_ENABLED !== 'false';
    this.takeProfitPercent = parseFloat(process.env.COPY_PROFIT_TARGET || '25');

    // 📉 Trailing Stop
    this.trailingStopEnabled = process.env.TRAILING_STOP_ENABLED !== 'false';
    this.trailingStopPercent = parseFloat(process.env.TRAILING_STOP || '12');

    // 🛑 Stop Loss
    this.stopLossEnabled = process.env.COPY_STOP_LOSS_ENABLED !== 'false';
    this.stopLoss = parseFloat(process.env.COPY_STOP_LOSS || '15');

    // ⏱️ Max hold
    this.maxHoldEnabled = process.env.COPY_MAX_HOLD_ENABLED === 'true';
    this.maxHoldSeconds = parseInt(process.env.COPY_MAX_HOLD || '240', 10);

    // ⏳ Cooldown entre entradas del MISMO token
    this.cooldownSeconds = parseInt(process.env.COPY_COOLDOWN || '60', 10);

    // 🚫 Anti-recompra por wallet+mint
    this.blockRebuys = process.env.BLOCK_REBUYS !== 'false'; // por defecto: true
    this.rebuyWindow = parseInt(process.env.REBUY_WINDOW || '300', 10); // 5 min

    console.log('🎯 Copy Strategy ANTI-RECOMPRA initialized');
    console.log(`   Min wallets to BUY: ${this.minWalletsToBuy}`);
    console.log(`   Min wallets to SELL: ${this.minWalletsToSell}`);
    console.log(`   🚫 Block rebuys: ${this.blockRebuys ? 'YES' : 'NO'}`);
    console.log(
      `   ⏰ Rebuy window: ${this.rebuyWindow}s (${(
        this.rebuyWindow / 60
      ).toFixed(1)}min)`
    );
    console.log('\n💰 EXIT STRATEGIES (Priority order):');
    console.log(
      `   1. Take Profit: ${
        this.takeProfitEnabled ? `+${this.takeProfitPercent}%` : 'Disabled'
      }`
    );
    console.log(
      `   2. Trailing Stop: ${
        this.trailingStopEnabled
          ? `-${this.trailingStopPercent}% from max`
          : 'Disabled'
      }`
    );
    console.log(
      `   3. Stop Loss: ${
        this.stopLossEnabled ? `-${this.stopLoss}%` : 'Disabled'
      }`
    );
    console.log(`   4. Traders Sell: ${this.minWalletsToSell}+ wallets`);
    if (this.maxHoldEnabled) {
      console.log(`   5. Max Hold Time: ${this.maxHoldSeconds}s`);
    }
    console.log('');
  }

  // =========================================================
  // 🟢 ENTRADA: decidir si copiamos o no
  // =========================================================
  async shouldCopy(copySignal) {
    try {
      const { mint, copyAmount, upvotes, buyers, walletAddress } = copySignal;
      const dryRun = process.env.DRY_RUN !== 'false';

      console.log(`\n🔍 Evaluating copy signal for ${mint.slice(0, 8)}...`);
      console.log(`   Upvotes: ${upvotes}/${this.minWalletsToBuy}`);

      // 1️⃣ En LIVE exige mínimo de wallets (en PAPER solo se loguea)
      if (!dryRun && upvotes < this.minWalletsToBuy) {
        console.log(
          `   ❌ Not enough upvotes for LIVE (need ${this.minWalletsToBuy})`
        );
        return {
          copy: false,
          reason: `low_upvotes (${upvotes}/${this.minWalletsToBuy})`,
        };
      }

      // 2️⃣ Anti-recompra por wallet+mint
      if (this.blockRebuys) {
        const isRebuy = await this.isRebuySignal(mint, walletAddress);
        if (isRebuy) {
          console.log(
            '   🚫 REBUY BLOCKED - Already traded this token from this wallet'
          );
          console.log('   ℹ️  Rule: One entry per token per wallet\n');
          return { copy: false, reason: 'rebuy_blocked' };
        }
      }

      // 3️⃣ Cooldown por token (independiente del wallet)
      const cooldown = await redis.get(`copy_cooldown:${mint}`);
      if (cooldown) {
        console.log('   ❌ Cooldown active (token recently traded)');
        return { copy: false, reason: 'cooldown' };
      }

      // 4️⃣ Evitar posición duplicada en el mismo token
      const hasPosition = await redis.sismember('open_positions', mint);
      if (hasPosition) {
        console.log('   ❌ Already have open position in this token');
        return { copy: false, reason: 'duplicate_position' };
      }

      // 5️⃣ Límite máximo de posiciones
      const openPositions = await redis.scard('open_positions');
      const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);
      if (openPositions >= maxPositions) {
        console.log(
          `   ❌ Max positions reached (${openPositions}/${maxPositions})`
        );
        return { copy: false, reason: 'max_positions' };
      }

      // ✅ COPIAR APROBADO
      const mode = dryRun ? 'PAPER' : 'LIVE';
      const confidence = this.calculateConfidence(upvotes);

      console.log(`   ✅ Copy approved for ${mode}`);
      console.log(`   Amount: ${copyAmount.toFixed(4)} SOL`);
      console.log(`   Confidence: ${confidence}%`);

      return {
        copy: true,
        amount: copyAmount,
        confidence,
        upvotes,
        buyers,
        mode: dryRun ? 'paper' : 'live',
      };
    } catch (error) {
      console.error('❌ Error in shouldCopy:', error.message);
      return { copy: false, reason: 'error' };
    }
  }

  // =========================================================
  // 🚫 ANTI-RECOMPRA
  // =========================================================
  async isRebuySignal(mint, walletAddress) {
    try {
      if (!walletAddress) {
        // Si por alguna razón no viene el wallet, no bloqueamos
        return false;
      }

      console.log('   🔍 Checking rebuy status...');

      // MÉTODO 1: ¿ya hay posición abierta en este mint de ese wallet?
      const hasOpenPosition = await redis.sismember('open_positions', mint);
      if (hasOpenPosition) {
        const position = await redis.hgetall(`position:${mint}`);
        if (position && position.walletSource === walletAddress) {
          console.log('      ⚠️  Already have OPEN position from this wallet');
          return true;
        }
      }

      // MÉTODO 2: historial del día actual
      const today = new Date().toISOString().split('T')[0];
      const todayTrades = await redis.lrange(`trades:${today}`, 0, -1);

      for (const tradeJson of todayTrades) {
        try {
          const trade = JSON.parse(tradeJson);
          if (trade.mint === mint && trade.walletSource === walletAddress) {
            const timeSinceClosed = Date.now() - (parseInt(trade.closedAt) || 0);
            const windowMs = this.rebuyWindow * 1000;
            const minutesAgo = timeSinceClosed / 60000;

            if (timeSinceClosed < windowMs) {
              console.log(
                `      ⏰ Already traded ${minutesAgo.toFixed(
                  1
                )}min ago (window: ${(this.rebuyWindow / 60).toFixed(1)}min)`
              );
              return true;
            }
          }
        } catch {
          // ignorar errores de parseo individuales
        }
      }

      // MÉTODO 3: historial extendido (últimos 7 días)
      for (let i = 1; i <= 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        const trades = await redis.lrange(`trades:${dateKey}`, 0, -1);

        for (const tradeJson of trades) {
          try {
            const trade = JSON.parse(tradeJson);
            if (trade.mint === mint && trade.walletSource === walletAddress) {
              const timeSinceClosed =
                Date.now() - (parseInt(trade.closedAt) || 0);
              const windowMs = this.rebuyWindow * 1000;
              if (timeSinceClosed < windowMs) {
                console.log('      📅 Found recent trade in history');
                return true;
              }
            }
          } catch {
            // ignorar errores
          }
        }
      }

      console.log('      ✅ First time or rebuy window passed');
      return false;
    } catch (error) {
      console.log(`      ⚠️  Rebuy check error: ${error.message}`);
      // En caso de duda, preferimos NO bloquear la entrada
      return false;
    }
  }

  // =========================================================
  // 🚪 SALIDA: decide si debe cerrar una posición
  // =========================================================
  async shouldExit(position, currentPrice) {
    try {
      const entryPrice = parseFloat(position.entryPrice);
      const maxPrice = parseFloat(position.maxPrice || position.entryPrice);
      const entryTime = parseInt(position.entryTime);
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      const maxPnlPercent = ((maxPrice - entryPrice) / entryPrice) * 100;
      const holdTime = (Date.now() - entryTime) / 1000;

      // 1️⃣ TAKE PROFIT
      if (this.takeProfitEnabled && pnlPercent >= this.takeProfitPercent) {
        console.log(
          `\n💰 ${position.symbol || 'COPY'}: TAKE PROFIT TRIGGERED`
        );
        console.log(
          `   Current: +${pnlPercent.toFixed(
            2
          )}% (target: +${this.takeProfitPercent}%)`
        );
        console.log(`   Max reached: +${maxPnlPercent.toFixed(2)}%`);
        console.log(`   Hold time: ${holdTime.toFixed(0)}s`);

        return {
          exit: true,
          reason: 'take_profit',
          pnl: pnlPercent,
          description: `Take profit: +${pnlPercent.toFixed(
            2
          )}% (target: +${this.takeProfitPercent}%)`,
          exitType: 'automatic',
          priority: 1,
        };
      }

      // 2️⃣ TRAILING STOP
      if (this.trailingStopEnabled && maxPnlPercent > 0) {
        const trailingPrice = maxPrice * (1 - this.trailingStopPercent / 100);
        const dropFromMax = ((maxPrice - currentPrice) / maxPrice) * 100;

        if (currentPrice <= trailingPrice) {
          console.log(
            `\n📉 ${position.symbol || 'COPY'}: TRAILING STOP TRIGGERED`
          );
          console.log(
            `   Max: $${maxPrice.toFixed(10)} (+${maxPnlPercent.toFixed(2)}%)`
          );
          console.log(
            `   Current: $${currentPrice.toFixed(
              10
            )} (+${pnlPercent.toFixed(2)}%)`
          );
          console.log(
            `   Drop from max: -${dropFromMax.toFixed(
              2
            )}% (limit: -${this.trailingStopPercent}%)`
          );
          console.log(
            `   Protecting profit: +${pnlPercent.toFixed(2)}%`
          );

          return {
            exit: true,
            reason: 'trailing_stop',
            pnl: pnlPercent,
            description: `Trailing stop: protecting +${pnlPercent.toFixed(
              2
            )}% (was +${maxPnlPercent.toFixed(2)}%)`,
            exitType: 'automatic',
            priority: 2,
          };
        }
      }

      // 3️⃣ STOP LOSS
      if (this.stopLossEnabled && pnlPercent <= -this.stopLoss) {
        console.log(
          `\n🛑 ${position.symbol || 'COPY'}: STOP LOSS TRIGGERED`
        );
        console.log(
          `   Current: ${pnlPercent.toFixed(
            2
          )}% (limit: -${this.stopLoss}%)`
        );
        console.log('   Protecting capital from further losses');

        return {
          exit: true,
          reason: 'stop_loss',
          pnl: pnlPercent,
          description: `Stop loss: ${pnlPercent.toFixed(
            2
          )}% (limit: -${this.stopLoss}%)`,
          exitType: 'automatic',
          priority: 3,
        };
      }

      // 4️⃣ TRADERS SELLING (señal externa)
      const sellCount = await this.countSellers(position.mint);
      if (sellCount >= this.minWalletsToSell) {
        console.log(`\n💼 ${position.symbol || 'COPY'}: TRADERS SELLING`);
        console.log(
          `   Sellers: ${sellCount}/${this.minWalletsToSell} wallets`
        );
        console.log(
          `   Current PnL: ${
            pnlPercent >= 0 ? '+' : ''
          }${pnlPercent.toFixed(2)}%`
        );
        console.log('   Following trader exit signal');

        return {
          exit: true,
          reason: 'traders_sold',
          pnl: pnlPercent,
          sellCount,
          description: `${sellCount} trader(s) sold - following exit`,
          exitType: 'signal',
          priority: 4,
        };
      }

      // 5️⃣ MAX HOLD TIME
      if (this.maxHoldEnabled && holdTime >= this.maxHoldSeconds) {
        console.log(
          `\n⏱️ ${position.symbol || 'COPY'}: MAX HOLD TIME EXCEEDED`
        );
        console.log(
          `   Hold time: ${holdTime.toFixed(
            0
          )}s (limit: ${this.maxHoldSeconds}s)`
        );
        console.log(
          `   Current PnL: ${
            pnlPercent >= 0 ? '+' : ''
          }${pnlPercent.toFixed(2)}%`
        );
        console.log('   Force exit due to timeout');

        return {
          exit: true,
          reason: 'max_hold_time',
          pnl: pnlPercent,
          description: `Max hold time: ${holdTime.toFixed(
            0
          )}s (PnL: ${pnlPercent.toFixed(2)}%)`,
          exitType: 'timeout',
          priority: 5,
        };
      }

      // ✅ SEGUIR HOLD
      return {
        exit: false,
        pnl: pnlPercent,
        maxPnl: maxPnlPercent,
        holdTime: holdTime.toFixed(0),
        sellCount,
        status: 'holding',
      };
    } catch (error) {
      console.error('❌ Error in shouldExit:', error.message);
      return { exit: false };
    }
  }

  // =========================================================
  // HELPERS
  // =========================================================
  async countSellers(mint) {
    try {
      const sellers = await redis.smembers(`upvotes:${mint}:sellers`);
      return sellers.length;
    } catch {
      return 0;
    }
  }

  calculateConfidence(upvotes) {
    if (upvotes === 1) return 30;
    if (upvotes === 2) return 70;
    if (upvotes >= 3) return 95;
    return 50;
  }

  async getBuyers(mint) {
    try {
      const buyers = await redis.smembers(`upvotes:${mint}:buyers`);
      const buyerDetails = [];

      for (const buyer of buyers) {
        const details = await redis.hgetall(`upvotes:${mint}:buy:${buyer}`);
        if (details && Object.keys(details).length > 0) {
          buyerDetails.push({
            address: buyer,
            name: details.walletName,
            amount: parseFloat(details.solAmount),
            timestamp: parseInt(details.timestamp),
          });
        }
      }

      return buyerDetails;
    } catch {
      return [];
    }
  }
}

// Export para debug / UI
export const COPY_STRATEGY_CONFIG = {
  minWalletsToBuy: process.env.MIN_WALLETS_TO_BUY || '1',

  takeProfitEnabled: process.env.COPY_PROFIT_TARGET_ENABLED || 'true',
  takeProfitPercent: process.env.COPY_PROFIT_TARGET || '25',

  trailingStopEnabled: process.env.TRAILING_STOP_ENABLED || 'true',
  trailingStopPercent: process.env.TRAILING_STOP || '12',

  stopLossEnabled: process.env.COPY_STOP_LOSS_ENABLED || 'true',
  stopLossPercent: process.env.COPY_STOP_LOSS || '15',

  minWalletsToSell: process.env.MIN_WALLETS_TO_SELL || '1',

  maxHoldEnabled: process.env.COPY_MAX_HOLD_ENABLED || 'true',
  maxHoldSeconds: process.env.COPY_MAX_HOLD || '240',

  blockRebuys: process.env.BLOCK_REBUYS || 'true',
  rebuyWindow: process.env.REBUY_WINDOW || '300',

  cooldown: process.env.COPY_COOLDOWN || '60',
};
