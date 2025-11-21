// server.js - Copy Trading Bot API with ENV CLEANER
import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

// 🧹 CRITICAL: Clean environment variables FIRST
console.log('🚀 Starting Copy Trading Bot Server...\n');
const envCleaner = cleanAndValidateEnv();

import express from 'express';
import IORedis from 'ioredis';

const app = express();
app.use(express.json());

let redis;
try {
  redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryDelayOnFailover: 100,
  });
  console.log('✅ Redis connected for server\n');
} catch (error) {
  console.log('⚠️ Redis not available for server');
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '💼 Copy Trading Bot API',
    mode: process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE',
  });
});

// 📊 Status endpoint
app.get('/status', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const openPositions = await redis.scard('open_positions');
    const trackedWallets = await redis.scard('tracked_wallets');
    const pendingSignals = await redis.llen('copy_signals');
    const dryRun = process.env.DRY_RUN !== 'false';

    // Get tracked wallets details
    const walletAddresses = await redis.smembers('tracked_wallets');
    const wallets = [];

    for (const address of walletAddresses) {
      const walletData = await redis.hgetall(`wallet:${address}`);
      if (walletData && Object.keys(walletData).length > 0) {
        wallets.push({
          address: address.slice(0, 16) + '...',
          name: walletData.name,
          enabled: walletData.enabled === 'true',
        });
      }
    }

    // Get positions details
    const positionMints = await redis.smembers('open_positions');
    const positions = [];

    for (const mint of positionMints) {
      const position = await redis.hgetall(`position:${mint}`);
      if (position && position.strategy === 'copy') {
        const entryPrice = parseFloat(position.entryPrice);
        const entryTime = parseInt(position.entryTime);
        const holdTime = ((Date.now() - entryTime) / 1000).toFixed(0);

        positions.push({
          mint: mint.slice(0, 16) + '...',
          wallet: position.walletName || 'Unknown',
          entryPrice: entryPrice.toFixed(10),
          holdTime: `${holdTime}s`,
          upvotes: position.upvotes || '1',
        });
      }
    }

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      trackedWallets: {
        count: trackedWallets,
        list: wallets,
      },
      positions: {
        count: openPositions,
        max: process.env.MAX_POSITIONS || '2',
        list: positions,
      },
      signals: {
        pending: pendingSignals,
      },
      config: {
        minWalletsToBuy: process.env.MIN_WALLETS_TO_BUY || '1',
        minWalletsToSell: process.env.MIN_WALLETS_TO_SELL || '1',
        positionSize: `${process.env.POSITION_SIZE_SOL || '0.1'} SOL`,
        stopLoss:
          process.env.COPY_STOP_LOSS_ENABLED !== 'false'
            ? `-${process.env.COPY_STOP_LOSS || '15'}%`
            : 'Disabled',
        profitTarget: `+${process.env.COPY_PROFIT_TARGET || '200'}%`,
        trailingStop: `-${process.env.TRAILING_STOP || '15'}%`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 👁️ List tracked wallets
app.get('/wallets', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const walletAddresses = await redis.smembers('tracked_wallets');
    const wallets = [];

    for (const address of walletAddresses) {
      const walletData = await redis.hgetall(`wallet:${address}`);
      const trades = await redis.lrange(`wallet_trades:${address}`, 0, -1);
      const copiedTrades = await redis.lrange(`copied_from:${address}`, 0, -1);

      if (walletData && Object.keys(walletData).length > 0) {
        wallets.push({
          address,
          name: walletData.name,
          copyPercentage: walletData.copyPercentage,
          enabled: walletData.enabled === 'true',
          stats: {
            tradesDetected: trades.length,
            tradesCopied: copiedTrades.length,
          },
        });
      }
    }

    res.json({
      count: wallets.length,
      wallets,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ➕ Add wallet to track
app.post('/wallets/add', async (req, res) => {
  try {
    const { address, name, copyPercentage = 100 } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const { getWalletTracker } = await import('./walletTracker.js');
    const tracker = getWalletTracker();

    if (!tracker) {
      return res.status(500).json({ error: 'Wallet tracker not initialized' });
    }

    const result = await tracker.addWallet(address, {
      name: name || `Wallet-${address.slice(0, 8)}`,
      copyPercentage,
      minAmount: 0.05,
      maxAmount: parseFloat(process.env.POSITION_SIZE_SOL || '0.1'),
    });

    if (result) {
      res.json({
        success: true,
        message: 'Wallet added successfully',
        wallet: {
          address,
          name: name || `Wallet-${address.slice(0, 8)}`,
          copyPercentage,
        },
      });
    } else {
      res.status(500).json({ error: 'Failed to add wallet' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ➖ Remove wallet
app.post('/wallets/remove', async (req, res) => {
  try {
    const { address } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const { getWalletTracker } = await import('./walletTracker.js');
    const tracker = getWalletTracker();

    if (!tracker) {
      return res.status(500).json({ error: 'Wallet tracker not initialized' });
    }

    const result = await tracker.removeWallet(address);

    if (result) {
      res.json({
        success: true,
        message: 'Wallet removed successfully',
      });
    } else {
      res.status(500).json({ error: 'Failed to remove wallet' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📊 Today's stats
app.get('/stats', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const { RiskManager } = await import('./riskManager.js');
    const riskManager = new RiskManager({}, redis);
    const stats = await riskManager.getDailyStats();

    if (!stats) {
      return res.json({ message: 'No trades today yet' });
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🧹 Cleanup endpoint
app.post('/cleanup', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    let cleaned = 0;

    // Limpiar open_positions
    const openPositions = await redis.smembers('open_positions');
    for (const mint of openPositions) {
      const position = await redis.hgetall(`position:${mint}`);

      if (
        !position ||
        Object.keys(position).length === 0 ||
        position.status === 'closed'
      ) {
        await redis.srem('open_positions', mint);
        cleaned++;
      }
    }

    res.json({
      success: true,
      cleaned,
      remaining: {
        openPositions: await redis.scard('open_positions'),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔍 Debug env endpoint (only show lengths/validation)
app.get('/debug/env', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const jupiterSlippageBps = process.env.JUPITER_SLIPPAGE_BPS;
  const copySlippage = process.env.COPY_SLIPPAGE;
  const priorityFeeSol = process.env.PRIORITY_FEE;

  res.json({
    privateKeyLength: process.env.PRIVATE_KEY?.length || 0,
    privateKeyValid: process.env.PRIVATE_KEY?.length === 88,
    rpcUrlValid: process.env.RPC_URL?.startsWith('https://') || false,
    redisUrlValid: !!process.env.REDIS_URL,
    pumpProgramId: process.env.PUMP_PROGRAM_ID || 'default (hardcoded in priceService)',
    pumpPortalApiKeyPresent: !!process.env.PUMPPORTAL_API_KEY,
    priorityFeeSol,
    priorityFeeMicrolamports: process.env.PRIORITY_FEE_MICROLAMPORTS,
    jupiterSlippageBps,
    copySlippage,
    positionSize: process.env.POSITION_SIZE_SOL,
    dryRun: process.env.DRY_RUN,
    autoTrading: process.env.ENABLE_AUTO_TRADING,
  });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}\n`);
  initializeModules();
});

async function initializeModules() {
  try {
    console.log('🔧 Initializing modules...\n');

    // 1. Iniciar Wallet Tracker
    if (process.env.RPC_URL) {
      try {
        const { initWalletTracker } = await import('./walletTracker.js');
        await initWalletTracker();
        console.log('✅ Wallet Tracker started\n');
      } catch (error) {
        console.log('⚠️ Wallet Tracker failed:', error.message);
      }
    } else {
      console.log('⚠️ RPC_URL missing - Wallet Tracker skipped\n');
    }

    // 2. Iniciar Telegram bot
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { initTelegram } = await import('./telegram.js');
        await initTelegram();
        console.log('✅ Telegram bot started\n');
      } catch (error) {
        console.log('⚠️ Telegram bot failed:', error.message);
      }
    } else {
      console.log('⚠️ TELEGRAM_BOT_TOKEN missing - Telegram skipped\n');
    }

    console.log('🎯 Copy Trading Configuration:');
    console.log(
      `   Min wallets to BUY: ${process.env.MIN_WALLETS_TO_BUY || '1'}`
    );
    console.log(
      `   Min wallets to SELL: ${process.env.MIN_WALLETS_TO_SELL || '1'}`
    );
    console.log(
      `   Position Size: ${process.env.POSITION_SIZE_SOL || '0.1'} SOL`
    );
    console.log(`   Max Positions: ${process.env.MAX_POSITIONS || '2'}`);
    console.log(
      `   Stop Loss: ${
        process.env.COPY_STOP_LOSS_ENABLED !== 'false'
          ? `Enabled (-${process.env.COPY_STOP_LOSS || '15'}%)`
          : 'Disabled'
      }`
    );
    console.log(
      `   Profit Target: +${process.env.COPY_PROFIT_TARGET || '200'}%`
    );
    console.log(
      `   Trailing Stop: -${process.env.TRAILING_STOP || '15'}%\n`
    );

    const mode =
      process.env.DRY_RUN !== 'false'
        ? '📄 PAPER TRADING'
        : '💰 LIVE TRADING';
    console.log(`🚀 Bot is ready in ${mode} mode\n`);
  } catch (error) {
    console.log('❌ Module initialization failed:', error.message);
  }
}

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err.message);
});
