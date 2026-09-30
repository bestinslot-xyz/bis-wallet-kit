// The swap protocol-fee policy. The swap backend owns it and serves it in
// /get_swap_info as `fee_policy`; the kit hardcodes none of it. The rule mirrors
// SwapSequencer's pricing.swapFeeBps, and both are checked against the same
// vectors (tests/unit/fee_vectors.json), because the backend rejects any swap
// whose signed fee split differs from its own by even one bp.

/**
 * The swap protocol-fee policy served by the swap backend (`/get_swap_info` →
 * `fee_policy`).
 */
export interface FeePolicy {
  /** Total protocol fee on a swap where either token is WBTC, in basis points. */
  swap_fee_bps: number
  /**
   * Total protocol fee on a swap where neither token is WBTC, in basis points.
   * Equals `swap_fee_bps` when the backend does not serve a separate token-pair rate.
   */
  token_pair_swap_fee_bps: number
  /** Lowercased token addresses that take the whole fee, highest priority first. WBTC is always first. */
  priority_tokens: string[]
  /** Minimum BTC exposure (sats) for a token/token pair's volume/TVL to be reported. A decimal string. */
  min_btc_exposure_sats: string
}

export const MISSING_FEE_POLICY_ERROR =
  'The swap backend did not return a fee_policy from get_swap_info, so it is older than this ' +
  'wallet-kit release and swap fees cannot be computed. Upgrade the swap backend, or pin ' +
  '@bestinslot/wallet-kit below 0.11.0.'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

function invalid(detail: string): Error {
  return new Error(`Invalid fee_policy from the swap backend: ${detail}`)
}

function isBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000
}

/**
 * Validates and normalises the raw `fee_policy` object from `/get_swap_info`.
 * Priority addresses are lowercased. An absent `token_pair_swap_fee_bps` takes
 * the value of `swap_fee_bps`.
 *
 * @param raw The `fee_policy` value exactly as the backend returned it.
 * @returns The validated policy.
 * @throws {Error} `MISSING_FEE_POLICY_ERROR` when `raw` is null/undefined (backend too old),
 * or an `Invalid fee_policy…` error when a field is malformed.
 */
export function parseFeePolicy(raw: unknown): FeePolicy {
  if (raw === undefined || raw === null) {
    throw new Error(MISSING_FEE_POLICY_ERROR)
  }
  if (typeof raw !== 'object') {
    throw invalid('not an object')
  }
  const {
    swap_fee_bps: rate,
    token_pair_swap_fee_bps: rawTokenPairRate,
    priority_tokens: priority,
    min_btc_exposure_sats: minExposure,
  } = raw as Record<string, unknown>

  if (!isBps(rate)) {
    throw invalid(`swap_fee_bps must be an integer in [0, 10000] (got ${String(rate)})`)
  }
  // A backend without a separate token-pair rate charges swap_fee_bps on every pair.
  const tokenPairRate = rawTokenPairRate === undefined ? rate : rawTokenPairRate
  if (!isBps(tokenPairRate)) {
    throw invalid(
      `token_pair_swap_fee_bps must be an integer in [0, 10000] (got ${String(tokenPairRate)})`
    )
  }
  if (!Array.isArray(priority) || priority.length === 0) {
    throw invalid('priority_tokens must be a non-empty array')
  }
  const priorityTokens = priority.map(token => {
    const addr = typeof token === 'string' ? token.toLowerCase() : ''
    if (!ADDRESS_RE.test(addr)) {
      throw invalid(`priority_tokens contains an invalid address (${String(token)})`)
    }
    return addr
  })
  if (typeof minExposure !== 'string' || !/^\d+$/.test(minExposure)) {
    throw invalid(`min_btc_exposure_sats must be a decimal string (got ${String(minExposure)})`)
  }

  return {
    swap_fee_bps: rate,
    token_pair_swap_fee_bps: tokenPairRate,
    priority_tokens: priorityTokens,
    min_btc_exposure_sats: minExposure,
  }
}

/**
 * The protocol-fee split for a swap. `token1` is always the input token, for both
 * exact-input and exact-output swaps.
 *
 * The rate is `swap_fee_bps` when either side is WBTC (`priority_tokens[0]`) and
 * `token_pair_swap_fee_bps` otherwise. If either side is a priority token, the
 * higher-priority side (lower index in `priority_tokens`) pays the full rate and
 * the other side pays 0, so a priority token on a token/token pair pays the whole
 * token-pair rate. Otherwise the rate is split, with the odd bp on the input
 * side: input `ceil(rate/2)`, output `floor(rate/2)`. Addresses are compared
 * lowercased.
 *
 * @param tokenIn The input token address.
 * @param tokenOut The output token address.
 * @param policy The backend's fee policy.
 * @returns The fee bps on the input (`token1FeeBps`) and output (`token2FeeBps`) legs.
 */
export function swapFeeBps(
  tokenIn: string,
  tokenOut: string,
  policy: FeePolicy
): { token1FeeBps: bigint; token2FeeBps: bigint } {
  const inRank = policy.priority_tokens.indexOf(tokenIn.toLowerCase())
  const outRank = policy.priority_tokens.indexOf(tokenOut.toLowerCase())
  const hasWbtc = inRank === 0 || outRank === 0
  const rate = BigInt(hasWbtc ? policy.swap_fee_bps : policy.token_pair_swap_fee_bps)

  if (inRank === -1 && outRank === -1) {
    const outShare = rate / 2n
    return { token1FeeBps: rate - outShare, token2FeeBps: outShare }
  }
  const inPays = inRank !== -1 && (outRank === -1 || inRank < outRank)
  return inPays
    ? { token1FeeBps: rate, token2FeeBps: 0n }
    : { token1FeeBps: 0n, token2FeeBps: rate }
}
