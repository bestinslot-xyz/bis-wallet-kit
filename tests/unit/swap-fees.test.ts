import type { UniswapInfoProxy } from '../../src/lib/uniswap_ops.ts'
import { assert, beforeAll, describe, it } from 'vitest'
import { POOL_FEE_BPS } from '../../src/lib/swap-constants.ts'
import { buildSwapFees } from '../../src/lib/swap-reporting.ts'
import { saveInfo, swap2Request, swapRequest } from '../../src/lib/uniswap_ops.ts'

// These drive the real AMM math through a stub proxy, so the fee breakdown is
// checked against the amounts swapRequest/swap2Request actually produce rather
// than against a re-implementation of them.

const WBTC = '0x00000000000000000000000000000000000000bc'
const TOKEN = '0x0000000000000000000000000000000000000abc'
const FACTORY = '0x0000000000000000000000000000000000001234'
const PUBKEY = 'ab'.repeat(256)

// A pool holding 10 BTC against 1,000,000 TOKEN, and a wallet with plenty of both.
const RESERVE_WBTC = 1_000_000_000n
const RESERVE_TOKEN = 1_000_000_000_000n
const MINER_FEE = 330n

// reservesOf reports a pair in address-sorted order and getReserves re-orients it,
// so derive the orientation rather than hard-coding it for these two addresses.
const TOKEN_IS_FIRST = TOKEN < WBTC

const proxy: UniswapInfoProxy = {
  balanceOf: async () => 1_000_000_000_000_000n,
  reservesOf: async () => ({
    reserveA: TOKEN_IS_FIRST ? RESERVE_TOKEN : RESERVE_WBTC,
    reserveB: TOKEN_IS_FIRST ? RESERVE_WBTC : RESERVE_TOKEN,
    total_supply: 1_000_000_000n,
  }),
}

// The constant-product quote, straight from the Uniswap V2 whitepaper. Written out
// independently here so the test fails if the pool fee ever silently drifts.
function refAmountOut(aIn: bigint, rIn: bigint, rOut: bigint): bigint {
  const aInWithFee = aIn * 997n
  return (aInWithFee * rOut) / (rIn * 1000n + aInWithFee)
}

beforeAll(() => saveInfo(WBTC, FACTORY))

describe('pOOL_FEE_BPS', () => {
  it('matches the 997/1000 factor the pool math applies', () => {
    // A swap of 1 unit against reserves so deep that price impact rounds away
    // leaves the pool fee as the only difference from a 1:1 quote.
    const huge = 10n ** 30n
    const aIn = 10n ** 12n
    const out = refAmountOut(aIn, huge, huge)
    const feeBps = ((aIn - out) * 10000n) / aIn
    assert.equal(feeBps, POOL_FEE_BPS)
  })
})

describe('buildSwapFees reconciles with swapRequest (exact input)', () => {
  // Selling TOKEN for WBTC: the protocol fee sits on the WBTC leg, which is the
  // output here, so token1FeeBps is 0 and token2FeeBps is 25 (see getSwapFeesBps).
  const AMOUNT_IN = 1_000_000_000n
  const TOKEN_IN_FEE_BPS = 0n
  const TOKEN_OUT_FEE_BPS = 25n

  it('reports a pool fee that reconciles amount_in to amount_out', async () => {
    const result = await swapRequest(
      proxy,
      PUBKEY,
      TOKEN,
      WBTC,
      AMOUNT_IN,
      0n,
      '',
      0n,
      TOKEN_IN_FEE_BPS,
      TOKEN_OUT_FEE_BPS,
      MINER_FEE,
    )
    assert.equal(result.success, true)
    const amountOut = result.amounts![1]!

    // The quoted output is the constant-product result with the pool fee applied:
    // applying pool_fee_bps to the input and pricing the remainder lands on it.
    assert.equal(amountOut, refAmountOut(AMOUNT_IN, RESERVE_TOKEN, RESERVE_WBTC))

    const fees = buildSwapFees(
      AMOUNT_IN,
      amountOut,
      TOKEN_IN_FEE_BPS,
      TOKEN_OUT_FEE_BPS,
      MINER_FEE,
    )
    assert.equal(fees.pool_fee_bps, 30n)

    // Worked example, in whole numbers: 1,000,000,000 TOKEN in against reserves of
    // 1,000,000,000,000 TOKEN / 1,000,000,000 WBTC sats.
    assert.equal(AMOUNT_IN, 1_000_000_000n)
    assert.equal(amountOut, 996_006n)
    assert.equal(fees.token_in_fee, 0n) // 0 bps on the TOKEN leg
    assert.equal(fees.token_out_fee, 2_490n) // 25 bps of 996,006, floored
    assert.equal(fees.miner_fee_sats, 330n)
    // So the wallet really receives 996,006 - 2,490 - 330 = 993,186 sats.
    assert.equal(amountOut - fees.token_out_fee - fees.miner_fee_sats, 993_186n)
  })

  it('reports fee amounts that match the debits the swap applies', async () => {
    const result = await swapRequest(
      proxy,
      PUBKEY,
      TOKEN,
      WBTC,
      AMOUNT_IN,
      0n,
      '',
      0n,
      TOKEN_IN_FEE_BPS,
      TOKEN_OUT_FEE_BPS,
      MINER_FEE,
    )
    const amountOut = result.amounts![1]!
    const fees = buildSwapFees(
      AMOUNT_IN,
      amountOut,
      TOKEN_IN_FEE_BPS,
      TOKEN_OUT_FEE_BPS,
      MINER_FEE,
    )

    // swapRequest debits (inAmt * token1FeeBps) / 10000 and (amounts[1] * token2FeeBps)
    // / 10000, floored. The reported amounts must be those exact figures.
    assert.equal(fees.token_in_fee, (AMOUNT_IN * TOKEN_IN_FEE_BPS) / 10000n)
    assert.equal(fees.token_out_fee, (amountOut * TOKEN_OUT_FEE_BPS) / 10000n)
    assert.equal(fees.miner_fee_sats, MINER_FEE)
  })

  it('carries a non-zero input-leg fee when WBTC is the input', async () => {
    // Buying TOKEN with WBTC flips which leg the protocol fee sits on.
    const wbtcIn = 1_000_000n
    const result = await swapRequest(proxy, PUBKEY, WBTC, TOKEN, wbtcIn, 0n, '', 0n, 25n, 0n, MINER_FEE)
    assert.equal(result.success, true)

    const fees = buildSwapFees(wbtcIn, result.amounts![1]!, 25n, 0n, MINER_FEE)
    assert.equal(fees.token_in_fee, 2_500n) // 25 bps of 1,000,000
    assert.equal(fees.token_out_fee, 0n)
    // The input leg really costs 1,000,000 + 2,500 sats, plus the 330 sat miner fee.
    assert.equal(wbtcIn + fees.token_in_fee + fees.miner_fee_sats, 1_002_830n)
  })
})

describe('buildSwapFees reconciles with swap2Request (exact output)', () => {
  it('prices the fees off the required input and the requested output', async () => {
    const AMOUNT_OUT = 1_000_000n // WBTC sats we want out
    const result = await swap2Request(
      proxy,
      PUBKEY,
      TOKEN,
      WBTC,
      2n ** 256n - 1n,
      AMOUNT_OUT,
      '',
      0n,
      0n,
      25n,
      MINER_FEE,
    )
    assert.equal(result.success, true)
    const amountIn = result.amounts![0]!

    // Round-tripping the exact-output quote back through the exact-input math must
    // land on the requested output (up to getAmountIn's +1 rounding in our favour).
    const roundTrip = refAmountOut(amountIn, RESERVE_TOKEN, RESERVE_WBTC)
    assert.isTrue(roundTrip >= AMOUNT_OUT)

    const fees = buildSwapFees(amountIn, AMOUNT_OUT, 0n, 25n, MINER_FEE)
    assert.equal(fees.pool_fee_bps, 30n)
    assert.equal(fees.token_in_fee, 0n)
    assert.equal(fees.token_out_fee, 2_500n) // 25 bps of the 1,000,000 requested
    assert.equal(fees.miner_fee_sats, 330n)
    // Asking for 1,000,000 sats out nets 1,000,000 - 2,500 - 330 = 997,170.
    assert.equal(AMOUNT_OUT - fees.token_out_fee - fees.miner_fee_sats, 997_170n)
  })
})
