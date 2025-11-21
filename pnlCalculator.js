// pnlCalculator.js - MEJORADO: Logs más claros y validación

export class PnLCalculator {
  /**
   * 💰 Calcula P&L CORRECTO incluyendo TODAS las fees
   * MEJORADO: Logs más informativos y validaciones
   */
  static calculatePnL(trade) {
    const {
      entryPrice,
      exitPrice,
      tokenAmount,
      solSpent,
      executor = 'pumpportal',
      slippage = 0,
      networkFee = 0.000005,
      priorityFee = 0
    } = trade;

    if (!entryPrice || !exitPrice || !tokenAmount || !solSpent) {
      throw new Error('❌ Missing required fields for PnL calculation');
    }

    // === VALIDACIONES INICIALES ===
    if (tokenAmount <= 0 || solSpent <= 0 || entryPrice <= 0 || exitPrice <= 0) {
      throw new Error('❌ All values must be positive');
    }

    // === FEES SEGÚN EXECUTOR (REALES) ===
    let buyFeeTotal, sellFeeTotal, executorLabel;
    
    if (executor === 'pumpportal') {
      buyFeeTotal = 0.0175;   // 1.75%
      sellFeeTotal = 0.0175;  // 1.75%
      executorLabel = 'PumpPortal (Pump.fun + 0.5%)';
    } else if (executor === 'jupiter') {
      buyFeeTotal = 0.003;    // ~0.3%
      sellFeeTotal = 0.003;   // ~0.3%
      executorLabel = 'Jupiter (DEX aggregator)';
    } else {
      buyFeeTotal = 0.01;
      sellFeeTotal = 0.01;
      executorLabel = 'Generic DEX';
    }

    console.log(`\n📊 P&L CALCULATION`);
    console.log(`════════════════════════════════════════`);
    console.log(`Executor: ${executorLabel}`);
    
    // === PASO 1: Análisis de la COMPRA ===
    console.log(`\n💵 ENTRY (BUY)`);
    console.log(`  Price: ${entryPrice.toFixed(10)} SOL/token`);
    console.log(`  Tokens: ${tokenAmount.toLocaleString()}`);
    console.log(`  SOL Spent: ${solSpent.toFixed(6)} SOL (already includes buy fees)`);
    
    // === PASO 2: Valor teórico de tokens al precio de salida ===
    const grossValue = tokenAmount * exitPrice;
    console.log(`\n💰 EXIT (SELL)`);
    console.log(`  Price: ${exitPrice.toFixed(10)} SOL/token`);
    console.log(`  Gross Value: ${grossValue.toFixed(6)} SOL`);
    
    // === PASO 3: Aplicar fee de venta ===
    const sellFeeAmount = grossValue * sellFeeTotal;
    const valueAfterSellFee = grossValue - sellFeeAmount;
    console.log(`  Sell Fee (${(sellFeeTotal * 100).toFixed(2)}%): -${sellFeeAmount.toFixed(6)} SOL`);
    console.log(`  After Sell Fee: ${valueAfterSellFee.toFixed(6)} SOL`);
    
    // === PASO 4: Aplicar slippage (si existe) ===
    let valueAfterSlippage = valueAfterSellFee;
    if (Math.abs(slippage) > 0.0001) {
      const slippageAmount = valueAfterSellFee * Math.abs(slippage);
      valueAfterSlippage = valueAfterSellFee - slippageAmount;
      console.log(`  Slippage (${(slippage * 100).toFixed(2)}%): -${slippageAmount.toFixed(6)} SOL`);
      console.log(`  After Slippage: ${valueAfterSlippage.toFixed(6)} SOL`);
    }
    
    // === PASO 5: Network fees ===
    const totalNetworkFee = networkFee + priorityFee;
    const netReceived = valueAfterSlippage - totalNetworkFee;
    console.log(`  Network Base: -${networkFee.toFixed(6)} SOL`);
    if (priorityFee > 0) {
      console.log(`  Priority Fee: -${priorityFee.toFixed(6)} SOL`);
    }
    console.log(`  ✅ NET RECEIVED: ${netReceived.toFixed(6)} SOL`);
    
    // === PASO 6: Calcular PnL final ===
    const pnlSOL = netReceived - solSpent;
    const pnlPercent = (pnlSOL / solSpent) * 100;
    
    // Cambio de precio puro (sin fees, para referencia)
    const priceChangePercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    
    // ✅ NUEVA MÉTRICA: Fee impact como % del capital invertido
    const totalFeeAmount = (solSpent * buyFeeTotal) + sellFeeAmount + totalNetworkFee;
    const feeImpactPercent = (totalFeeAmount / solSpent) * 100;
    
    console.log(`\n═══════════════════════════════════════`);
    console.log(`📈 FINAL RESULT`);
    console.log(`  ${pnlSOL >= 0 ? '🟢' : '🔴'} PnL: ${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(6)} SOL`);
    console.log(`  ${pnlPercent >= 0 ? '🟢' : '🔴'} PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
    console.log(`  📊 Price Change: ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%`);
    console.log(`  💸 Total Fees: -${totalFeeAmount.toFixed(6)} SOL (${feeImpactPercent.toFixed(2)}% of entry)`);
    console.log(`════════════════════════════════════════\n`);
    
    return {
      pnlSOL: Number(pnlSOL.toFixed(6)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
      priceChangePercent: Number(priceChangePercent.toFixed(2)),
      netReceived: Number(netReceived.toFixed(6)),
      totalFeeAmount: Number(totalFeeAmount.toFixed(6)),
      feeImpactPercent: Number(feeImpactPercent.toFixed(2)),
      breakdown: {
        entry: {
          price: entryPrice,
          tokens: tokenAmount,
          solSpent,
          buyFeePercent: buyFeeTotal,
          buyFeeAmount: solSpent * buyFeeTotal,
        },
        exit: {
          price: exitPrice,
          grossValue,
          sellFeeAmount,
          sellFeePercent: sellFeeTotal,
          valueAfterSellFee,
          slippageAmount: valueAfterSellFee - valueAfterSlippage,
          slippagePercent: slippage,
          valueAfterSlippage,
          networkFee,
          priorityFee,
          totalNetworkFee,
          netReceived,
        },
        executor,
        executorLabel,
      },
    };
  }

  /**
   * 📈 PnL UNREALIZADO (posición abierta)
   * MEJORADO: Validaciones más estrictas
   */
  static calculateUnrealizedPnL(position, currentPrice, options = {}) {
    const {
      executor = 'pumpportal',
      estimatedSlippage = 0.02,
      networkFee = 0.000005,
      priorityFee = 0
    } = options;

    const entryPrice = Number(position.entryPrice);
    const solSpent = Number(position.solAmount || position.solSpent);
    const tokenAmount = Number(position.tokensAmount || position.tokenAmount);

    if (!entryPrice || !solSpent || !tokenAmount || !currentPrice) {
      throw new Error('❌ Missing fields for unrealized PnL');
    }

    if (currentPrice <= 0 || entryPrice <= 0) {
      throw new Error('❌ Prices must be positive');
    }

    // Fees según executor
    const sellFeeTotal = executor === 'pumpportal' ? 0.0175 : 0.003;

    // Simular venta
    const grossValue = tokenAmount * currentPrice;
    const sellFeeAmount = grossValue * sellFeeTotal;
    const valueAfterFee = grossValue - sellFeeAmount;
    const slippageAmount = valueAfterFee * estimatedSlippage;
    const valueAfterSlippage = valueAfterFee - slippageAmount;
    const totalNetworkFee = networkFee + priorityFee;
    const netReceived = valueAfterSlippage - totalNetworkFee;

    const pnlSOL = netReceived - solSpent;
    const pnlPercent = (pnlSOL / solSpent) * 100;
    const holdTimeMs = Date.now() - Number(position.entryTime || Date.now());

    return {
      current: {
        price: currentPrice,
        grossValue,
        sellFeeAmount,
        sellFeePercent: sellFeeTotal,
        valueAfterFee,
        slippageEstimate: slippageAmount,
        valueAfterSlippage,
        networkFee: totalNetworkFee,
        netReceived,
      },
      pnlSOL: Number(pnlSOL.toFixed(6)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
      holdTimeMs,
      executor,
    };
  }

  /**
   * ⚠️ Detecta inconsistencias en los cálculos
   * MEJORADO: Más tolerante y con mejor reporting
   */
  static checkDiscrepancy(trade) {
    try {
      const result = this.calculatePnL(trade);
      const discrepancy = Math.abs(result.priceChangePercent - result.pnlPercent);

      // Tolerancia: 5% de discrepancia es normal por fees
      if (discrepancy > 5) {
        console.warn(`\n⚠️ DISCREPANCY DETECTED`);
        console.warn(`  Price moved: ${result.priceChangePercent.toFixed(2)}%`);
        console.warn(`  Your P&L: ${result.pnlPercent.toFixed(2)}%`);
        console.warn(`  Difference: ${discrepancy.toFixed(2)}%`);
        console.warn(`  Expected: ~${result.feeImpactPercent.toFixed(2)}% from fees`);
        
        if (discrepancy > result.feeImpactPercent * 2) {
          console.warn(`  🔴 ANOMALY: Fees too high or data inconsistent!\n`);
          return {
            hasHighImpact: true,
            feeImpact: discrepancy,
            severity: 'HIGH',
            reason: 'Fees exceed expected amount'
          };
        }
      }

      return {
        hasHighImpact: false,
        feeImpact: discrepancy,
        severity: 'OK'
      };
    } catch (err) {
      console.error('❌ Discrepancy check error:', err.message);
      return { hasHighImpact: false, severity: 'ERROR' };
    }
  }
}
