// Pure, framework-agnostic helpers for reporting on swap data — buy/sell side
// classification, sat → BTC/USD conversion and the swap fee breakdown. No network,
// no decimals magic: the converters take values already in sats so their contract
// is unambiguous, and the fee breakdown is assembled from values the caller holds.

import { POOL_FEE_BPS } from './swap-constants'

/**
 * Classifies a swap as a buy or sell relative to WBTC (the quote asset): you
 * "buy" the other token when you spend WBTC, and "sell" it when you receive WBTC.
 *
 * For a swap activity entry (`type` 'swap1' | 'swap2'), `token_1` is the input
 * and `token_2` the output, so `swapSide(entry.token_1, entry.token_2, wbtc)`
 * gives its side. (Don't apply it to liquidity entries, where token_1/token_2 are
 * the pair's two tokens, not a direction.)
 *
 * @param tokenInAddress The input token address (what's spent).
 * @param tokenOutAddress The output token address (what's received).
 * @param wbtcAddress The WBTC token address.
 * @returns 'buy' or 'sell', or null for a non-WBTC (token-to-token) swap.
 */
export function swapSide(
  tokenInAddress: string,
  tokenOutAddress: string,
  wbtcAddress: string,
): 'buy' | 'sell' | null {
  const wbtc = wbtcAddress.toLowerCase()
  if (tokenInAddress.toLowerCase() === wbtc) {
    return 'buy'
  }
  if (tokenOutAddress.toLowerCase() === wbtc) {
    return 'sell'
  }
  return null
}

/**
 * Converts a sat amount to BTC. Throws on values beyond JS safe-integer
 * precision (~90,000 BTC) rather than silently rounding.
 *
 * @param sats The amount in satoshis.
 * @returns The amount in BTC.
 */
export function satsToBtc(sats: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (sats > max || sats < -max) {
    throw new RangeError('satsToBtc: amount exceeds safe-integer precision (~90,000 BTC).')
  }
  return Number(sats) / 1e8
}

/**
 * Converts a sat amount to USD using a caller-supplied BTC/USD rate, keeping the
 * library oracle-free.
 *
 * @param sats The amount in satoshis.
 * @param btcUsd The BTC→USD price.
 * @returns The amount in USD.
 */
export function satsToUsd(sats: bigint, btcUsd: number): number {
  return satsToBtc(sats) * btcUsd
}

/**
 * The fees a swap quote costs, broken out so a UI can show the real total instead
 * of guessing at it. Only the pool fee is baked into the quoted amounts; the rest
 * is charged on top of them — see each field, and the swap guide for a worked
 * example of totalling them up.
 */
export interface SwapFees {
  /**
   * The constant-product pool fee, in bps. This one is already reflected in the
   * quote: it is taken on the way through the pool, so the quoted amount is net
   * of it and it must not be subtracted again.
   */
  pool_fee_bps: bigint
  /** The protocol fee charged on the input leg, in bps. */
  token_in_fee_bps: bigint
  /**
   * `token_in_fee_bps` applied to the input amount, in input-token units. Debited
   * on top of the input, so the swap really costs `amount_in + token_in_fee`.
   */
  token_in_fee: bigint
  /** The protocol fee charged on the output leg, in bps. */
  token_out_fee_bps: bigint
  /**
   * `token_out_fee_bps` applied to the output amount, in output-token units.
   * Deducted from the output, so you really receive `amount_out - token_out_fee`.
   */
  token_out_fee: bigint
  /**
   * The miner fee, in WBTC sats. A flat amount rather than a rate — don't fold it
   * into a bps figure. Debited in WBTC separately from both legs.
   */
  miner_fee_sats: bigint
}

/**
 * Assembles the fee breakdown for a swap quote from the inputs the quote path
 * already has. The bps → amount arithmetic mirrors `swapRequest`/`swap2Request`
 * exactly, floor division included, so the reported amounts are the ones that
 * will actually be debited rather than a rounded-off approximation.
 *
 * @param amountIn The input leg amount, whether quoted or requested.
 * @param amountOut The output leg amount, whether quoted or requested.
 * @param token1FeeBps The protocol fee on the input leg, in bps.
 * @param token2FeeBps The protocol fee on the output leg, in bps.
 * @param btcFee The miner fee in WBTC sats.
 *
 * @returns The fee breakdown for the quote.
 */
export function buildSwapFees(
  amountIn: bigint,
  amountOut: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  btcFee: bigint,
): SwapFees {
  return {
    pool_fee_bps: POOL_FEE_BPS,
    token_in_fee_bps: token1FeeBps,
    token_in_fee: (amountIn * token1FeeBps) / 10000n,
    token_out_fee_bps: token2FeeBps,
    token_out_fee: (amountOut * token2FeeBps) / 10000n,
    miner_fee_sats: btcFee,
  }
}
