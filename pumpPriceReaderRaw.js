// pumpPriceReaderRaw.js - Leer precio directo de Pump.fun con RAW RPC (sin SDK)
import { Connection, PublicKey } from '@solana/web3.js';

const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkp1KPcLW7jkZo4U9AWhjbnESmtDDMTP',
);
const PUMP_CURVE_SEED = Buffer.from('bonding-curve');

// ✅ IDL discriminator para validar la cuenta (primeros 8 bytes)
const BONDING_CURVE_DISCRIMINATOR = Buffer.from([
  0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60,
]);

// ✅ Offsets en la cuenta BondingCurve según el IDL de Pump.fun
const OFFSETS = {
  VIRTUAL_TOKEN_RESERVES: 0x08,
  VIRTUAL_SOL_RESERVES: 0x10,
  REAL_TOKEN_RESERVES: 0x18,
  REAL_SOL_RESERVES: 0x20,
  TOKEN_TOTAL_SUPPLY: 0x28,
  COMPLETE: 0x30,
};

// BigInt helpers
const SOL_DECIMALS = 1_000_000_000n; // lamports
const TOKEN_DECIMALS = 1_000_000n; // pump.fun tokens (6 decimales)

export class PumpPriceReaderRaw {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    console.log('✅ PumpPriceReaderRaw initialized (RAW RPC)');
    console.log(`   RPC: ${rpcUrl}`);
    console.log(`   Pump.fun Program ID: ${PUMP_PROGRAM_ID.toBase58()}\n`);
  }

  /**
   * Derivar PDA de bonding curve para un mint
   */
  findBondingCurveAddress(tokenMint) {
    const [curveAddress] = PublicKey.findProgramAddressSync(
      [PUMP_CURVE_SEED, tokenMint.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return curveAddress;
  }

  /**
   * Leer y parsear manualmente la cuenta de Pump.fun
   * Devuelve:
   * {
   *   price: number | null,
   *   bondingProgress: number,
   *   graduated: boolean,
   *   curveAddress: string,
   *   reserves: {...}
   * }
   */
  async getPrice(mintStr) {
    try {
      const mint = new PublicKey(mintStr);
      const curveAddress = this.findBondingCurveAddress(mint);

      const accountInfo = await this.connection.getAccountInfo(curveAddress);

      if (!accountInfo || !accountInfo.data) {
        // No hay bonding curve -> probablemente aún no hay pool o ya está graduado fuera de Pump.fun
        console.log(
          `   ℹ️ No bonding curve account for ${mintStr.slice(0, 8)}...`,
        );
        return null;
      }

      const data = accountInfo.data;

      // Validar discriminator (IDL signature)
      const discriminator = data.subarray(0, 8);
      if (!discriminator.equals(BONDING_CURVE_DISCRIMINATOR)) {
        throw new Error('Invalid bonding curve discriminator');
      }

      // Leer campos usando offsets del IDL
      const virtualTokenReserves = data.readBigUInt64LE(
        OFFSETS.VIRTUAL_TOKEN_RESERVES,
      );
      const virtualSolReserves = data.readBigUInt64LE(
        OFFSETS.VIRTUAL_SOL_RESERVES,
      );
      const realTokenReserves = data.readBigUInt64LE(
        OFFSETS.REAL_TOKEN_RESERVES,
      );
      const realSolReserves = data.readBigUInt64LE(
        OFFSETS.REAL_SOL_RESERVES,
      );
      const tokenTotalSupply = data.readBigUInt64LE(
        OFFSETS.TOKEN_TOTAL_SUPPLY,
      );
      const complete = data.readUInt8(OFFSETS.COMPLETE) !== 0;

      if (complete) {
        console.log(
          `   🎓 Token ${mintStr.slice(0, 8)}... marked as COMPLETE (graduated)`,
        );
        return {
          price: null,
          bondingProgress: 1,
          graduated: true,
          curveAddress: curveAddress.toBase58(),
          reserves: {
            virtualTokenReserves: virtualTokenReserves.toString(),
            virtualSolReserves: virtualSolReserves.toString(),
            realTokenReserves: realTokenReserves.toString(),
            realSolReserves: realSolReserves.toString(),
            tokenTotalSupply: tokenTotalSupply.toString(),
          },
        };
      }

      if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n) {
        throw new Error('Invalid reserves (zero or negative)');
      }

      // Calcular precio con precisión BigInt: (SOL / token)
      const numerator = virtualSolReserves * TOKEN_DECIMALS; // SOL * 10^token_dec
      const denominator = virtualTokenReserves * SOL_DECIMALS; // tokens * 10^sol_dec
      const price = Number(numerator) / Number(denominator);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price: ${price}`);
      }

      // Bonding progress basado en realTokenReserves
      const INITIAL_REAL_TOKEN_RESERVES = 793100000000000n;
      let bondingProgress = 0;
      if (realTokenReserves < INITIAL_REAL_TOKEN_RESERVES) {
        bondingProgress =
          1 -
          Number(
            (realTokenReserves * 10000n) / INITIAL_REAL_TOKEN_RESERVES,
          ) /
            10000;
      }

      // Logs suaves para debug, pero no spam
      console.log(
        `   💰 Pump.fun RAW: ${mintStr.slice(0, 8)}... = ${price.toExponential(
          6,
        )} SOL`,
      );
      console.log(
        `   📊 Bonding progress: ${(bondingProgress * 100).toFixed(2)}%`,
      );

      return {
        price,
        bondingProgress,
        graduated: false,
        curveAddress: curveAddress.toBase58(),
        reserves: {
          virtualTokenReserves: virtualTokenReserves.toString(),
          virtualSolReserves: virtualSolReserves.toString(),
          realTokenReserves: realTokenReserves.toString(),
          realSolReserves: realSolReserves.toString(),
          tokenTotalSupply: tokenTotalSupply.toString(),
        },
      };
    } catch (err) {
      console.error(
        `   ❌ PumpPriceReaderRaw error for ${mintStr.slice(0, 8)}...: ${
          err.message
        }`,
      );
      return null;
    }
  }
}

// Pequeño main para testing local (no afecta en Railway)
async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) {
    console.error('Missing RPC_URL env var for PumpPriceReaderRaw test');
    return;
  }

  const reader = new PumpPriceReaderRaw(rpc);
  const mint =
    process.env.TEST_PUMP_MINT ||
    'GjSn1XHncttWZtx9u6JB9BNM3QYqiumXfGbtkm4ypump';

  const priceData = await reader.getPrice(mint);

  if (priceData && priceData.price) {
    console.log(`\n✅ Test price for ${mint}: ${priceData.price} SOL`);
  } else {
    console.log(`\n⚠️ No price returned for ${mint}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default PumpPriceReaderRaw;
