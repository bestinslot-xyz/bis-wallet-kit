// Pure, framework-agnostic helpers for reporting on swap data — buy/sell side
// classification and sat → BTC/USD conversion. No network, no decimals magic:
// the converters take values already in sats so their contract is unambiguous.

/**
 * Classifies a swap as a buy or sell relative to WBTC (the quote asset): you
 * "buy" the other token when you spend WBTC, and "sell" it when you receive WBTC.
 *
 * Apply it to an activity entry's input/output token addresses, e.g.
 * `swapSide(entry.token_1, entry.token_2, wbtcAddress)`.
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
 * Converts a sat amount to BTC.
 *
 * @param sats The amount in satoshis.
 * @returns The amount in BTC.
 */
export function satsToBtc(sats: bigint): number {
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
