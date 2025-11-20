// pnlCalculator.js - Cálculo de PnL CORRECTO basado en SOL

export class PnLCalculator {
  /**
   * Calcula P&L CORRECTO incluyendo todas las fees
   *
   * @param {Object} trade - {entryPrice, exitPrice, tokenAmount, solSpent, fees?}
   * @returns {Object} - {pnlSOL, pnlPercent, priceChangePercent, breakdown}
   */
  static calculatePnL(trade) {
    const {
      entryPrice,      // Precio al que compraste (SOL/token)
      exitPrice,       // Precio al que vendiste (SOL/token)
      tokenAmount,     // Cantidad de tokens
      solSpent,        // SOL gastado en compra (incluyendo fees)
      fees = {}        // { buyFee: 0.01, sellFee: 0.01 }
    } = trade;

    if (!entryPrice || !exitPrice || !tokenAmount || !solSpent) {
      throw new Error('Missing required fields for PnL calculation');
    }

    const buyFeePercent = fees.buyFee ?? 0.01;   // 1% por defecto
    const sellFeePercent = fees.sellFee ?? 0.01; // 1% por defecto

    // === Paso 1: SOL que valen los tokens al precio de salida (antes de fee) ===
    const solBeforeSellFee = tokenAmount * exitPrice;

    // === Paso 2: SOL después de fee de venta ===
    const solAfterSellFee = solBeforeSellFee * (1 - sellFeePercent);

    // === Paso 3: PnL en SOL ===
    const pnlSOL = solAfterSellFee - solSpent;

    // === Paso 4: PnL en % relativo al SOL gastado ===
    const pnlPercent = (pnlSOL / solSpent) * 100;

    // Referencia: PnL basado solo en precios (sin fees)
    const priceChangePercent = ((exitPrice - entryPrice) / entryPrice) * 100;

    // Logs de depuración (puedes comentar si hacen demasiado ruido)
    console.log(`\n📊 P&L BREAKDOWN`);
    console.log(`  Entry Price: ${entryPrice.toFixed(10)} SOL/token`);
    console.log(`  Exit  Price: ${exitPrice.toFixed(10)} SOL/token`);
    console.log(`  Tokens: ${tokenAmount}`);
    console.log(`  SOL Spent (with buy fee): ${solSpent.toFixed(6)} SOL`);
    console.log(`  ---`);
    console.log(`  Value before sell fee: ${solBeforeSellFee.toFixed(6)} SOL`);
    console.log(`  Sell fee (${(sellFeePercent * 100).toFixed(2)}%): ${(solBeforeSellFee * sellFeePercent).toFixed(6)} SOL`);
    console.log(`  SOL Received (after fee): ${solAfterSellFee.toFixed(6)} SOL`);
    console.log(`  ---`);
    console.log(`  💰 PnL SOL: ${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(6)} SOL`);
    console.log(`  📈 PnL %: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
    console.log(`  (Price-only change: ${priceChangePercent.toFixed(2)}%)`);

    return {
      pnlSOL,
      pnlPercent,
      priceChangePercent,
      breakdown: {
        solSpent,
        entryPrice,
        exitPrice,
        tokenAmount,
        solBeforeSellFee,
        sellFeeAmount: solBeforeSellFee * sellFeePercent,
        solAfterSellFee,
        fees: {
          buyFeePercent,
          sellFeePercent,
        },
      },
    };
  }

  /**
   * PnL UNREALIZADO (posición abierta) usando precio actual
   * Incluye fee estimada + slippage estimado si vendieras AHORA
   *
   * @param {Object} position - datos guardados de la posición
   * @param {number} currentPrice - precio SOL/token actual
   * @param {number} estimatedSlippage - slippage estimado (0.02 = 2%)
   */
  static calculateUnrealizedPnL(position, currentPrice, estimatedSlippage = 0.02) {
    const entryPrice = Number(position.entryPrice);
    const solSpent = Number(position.solAmount ?? position.solSpent ?? 0);
    const tokenAmount = Number(position.tokensAmount ?? position.tokenAmount ?? 0);

    if (!entryPrice || !solSpent || !tokenAmount || !currentPrice) {
      throw new Error('Missing required fields for unrealized PnL');
    }

    const sellFeePercent = 0.01; // 1% por defecto

    const solBeforeFee = tokenAmount * currentPrice;
    const feeAmount = solBeforeFee * sellFeePercent;
    const solAfterFee = solBeforeFee - feeAmount;

    const slippageAmount = solAfterFee * estimatedSlippage;
    const solAfterSlippage = solAfterFee - slippageAmount;

    const pnlSOL = solAfterSlippage - solSpent;
    const pnlPercent = (pnlSOL / solSpent) * 100;

    const holdTimeMs = Date.now() - Number(position.entryTime || Date.now());

    return {
      current: {
        price: currentPrice,
        valueBeforeFee: solBeforeFee,
        feeAmount,
        valueAfterFee: solAfterFee,
        slippageEstimate: slippageAmount,
        valueAfterSlippage: solAfterSlippage,
      },
      pnlSOL,
      pnlPercent,
      holdTimeMs,
    };
  }

  /**
   * Check de discrepancia entre PnL basado en precio vs PnL basado en SOL
   * Útil para debug cuando ves cosas raras.
   */
  static checkDiscrepancy(trade) {
    const result = this.calculatePnL(trade);
    const discrepancy = Math.abs(result.priceChangePercent - result.pnlPercent);

    if (discrepancy > 3) {
      console.warn(`\n⚠️ PnL DISCREPANCY: ${discrepancy.toFixed(2)}%`);
      console.warn(`  Price-based PnL: ${result.priceChangePercent.toFixed(2)}%`);
      console.warn(`  SOL-based   PnL: ${result.pnlPercent.toFixed(2)}%`);
      console.warn(`  Esto indica impacto fuerte de fees/slippage.`);
    }

    return {
      hasDiscrepancy: discrepancy > 3,
      discrepancy,
    };
  }
}
