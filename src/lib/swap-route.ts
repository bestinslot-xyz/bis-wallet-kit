// Swap routes and the swap order messages signed for them. The swap backend
// (SwapSequencer routing.js / userapi.js) checks the same formats.
//
// A swap path lists 2 or 3 token addresses, input first: the sequencer contract
// packs at most three token indexes into a swap op, so a route has at most two
// hops. Each hop pays its pool's LP fee; the protocol fee is charged once, on
// the path's endpoints.

import { Buffer } from 'node:buffer'
import * as ethers from 'ethers'

/** The most tokens a swap path can list (two hops). */
export const MAX_SWAP_PATH_LENGTH = 3

// 25% of the swap fee is paid out to the referrer; part of the BLS message when a referrer is set.
const REFERRER_FEE_BPS = 2500n

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** One pool step of a swap route. Amounts are in base units. */
export interface SwapRouteHop {
  pair_address: string
  token_in: string // lowercased
  token_out: string // lowercased
  amount_in: bigint
  amount_out: bigint
  /** The pool's LP fee, in bps. Already reflected in `amount_out`. */
  lp_fee_bps: bigint
}

/**
 * The best route the swap backend found for a swap at current reserves.
 *
 * `amounts[0]` is the input and `amounts[amounts.length - 1]` the output; with an exact input the
 * first is the amount asked for, with an exact output the last is. Pass `path` to
 * `swapExactInput` / `swapExactOutput` to execute this route.
 */
export interface SwapRoute {
  /** Token addresses from input to output, lowercased: 2 for a direct swap, 3 for a routed one. */
  path: string[]
  /** The amount at each token of `path`, net of LP fees. */
  amounts: bigint[]
  hops: SwapRouteHop[]
  /** The LP fee of every hop added up, in bps. */
  lp_fee_bps_total: bigint
  /** The protocol fee on the input token, in bps (the swap's `token1FeeBps`). */
  token1FeeBps: bigint
  /** The protocol fee on the output token, in bps (the swap's `token2FeeBps`). */
  token2FeeBps: bigint
}

/** The `result` of the swap backend's `/get_swap_route`, as served. */
export interface RawSwapRoute {
  path: string[]
  amounts: string[]
  hops: {
    pair_address: string
    token_in: string
    token_out: string
    amount_in: string
    amount_out: string
    lp_fee_bps: number | string
  }[]
  lp_fee_bps_total: number | string
  token1FeeBps: string
  token2FeeBps: string
}

/**
 * Converts a `/get_swap_route` result into a `SwapRoute`, checking that its path is one the swap
 * flow can sign.
 *
 * @param raw The backend's route.
 * @param tokenIn The input token asked for.
 * @param tokenOut The output token asked for.
 * @returns The route with bigint amounts and lowercased addresses.
 * @throws {Error} If the path does not run from `tokenIn` to `tokenOut` or is malformed.
 */
export function parseSwapRoute(raw: RawSwapRoute, tokenIn: string, tokenOut: string): SwapRoute {
  const path = resolveSwapPath(raw.path, tokenIn, tokenOut)
  if (raw.amounts.length !== path.length || raw.hops.length !== path.length - 1) {
    throw new Error('The swap backend returned a route whose amounts do not match its path.')
  }
  return {
    path,
    amounts: raw.amounts.map(a => BigInt(a)),
    hops: raw.hops.map(h => ({
      pair_address: h.pair_address.toLowerCase(),
      token_in: h.token_in.toLowerCase(),
      token_out: h.token_out.toLowerCase(),
      amount_in: BigInt(h.amount_in),
      amount_out: BigInt(h.amount_out),
      lp_fee_bps: BigInt(h.lp_fee_bps),
    })),
    lp_fee_bps_total: BigInt(raw.lp_fee_bps_total),
    token1FeeBps: BigInt(raw.token1FeeBps),
    token2FeeBps: BigInt(raw.token2FeeBps),
  }
}

/**
 * Checks a swap path against the swap's input and output tokens, as the swap backend does.
 *
 * @param path Token addresses from `token1` to `token2`, or `undefined` for the direct path.
 * @param token1 The input token.
 * @param token2 The output token.
 * @returns The path lowercased; `[token1, token2]` when `path` is undefined.
 * @throws {Error} If the path lists fewer than 2 or more than 3 tokens, holds an invalid or
 *   repeated address, or does not start at `token1` and end at `token2`.
 */
export function resolveSwapPath(
  path: readonly string[] | undefined,
  token1: string,
  token2: string
): string[] {
  const t1 = token1.toLowerCase()
  const t2 = token2.toLowerCase()
  if (path === undefined) return [t1, t2]
  if (!Array.isArray(path) || path.length < 2 || path.length > MAX_SWAP_PATH_LENGTH) {
    throw new Error(`A swap path must list 2 to ${MAX_SWAP_PATH_LENGTH} token addresses.`)
  }
  const p = path.map(a => (typeof a === 'string' ? a.toLowerCase() : ''))
  if (!p.every(a => ADDRESS_RE.test(a))) {
    throw new Error('A swap path contains an invalid token address.')
  }
  if (new Set(p).size !== p.length) {
    throw new Error('A swap path cannot repeat a token.')
  }
  if (p[0] !== t1 || p[p.length - 1] !== t2) {
    throw new Error('A swap path must start at the input token and end at the output token.')
  }
  return p
}

/** The fields shared by the exact-input and exact-output BIP322 swap texts. */
interface SwapOrderTextFields {
  /** Token addresses from input to output; the direct path is `[token1, token2]`. */
  path: readonly string[]
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  referrer_pubkey?: string // no 0x
  ref_return_bps?: string
}

function swapOrderText(amountLines: string, fields: SwapOrderTextFields): string {
  const path = fields.path.map(a => a.toLowerCase())
  const token1 = path[0]
  const token2 = path[path.length - 1]
  const routeLine = path.length > 2 ? `Route: ${path.join(' -> ')}\n` : ''
  const referrerLine = fields.referrer_pubkey ? `Referrer Pubkey: ${fields.referrer_pubkey}\n` : ''
  const refReturnLine =
    fields.ref_return_bps && BigInt(fields.ref_return_bps) > 0n
      ? `Referrer Return Bps: ${fields.ref_return_bps}\n`
      : ''
  return `Swap Order:
Token 1 Address: ${token1}
Token 2 Address: ${token2}
${routeLine}${amountLines}
Token 1 Fee Bps: ${fields.token1FeeBps}
Token 2 Fee Bps: ${fields.token2FeeBps}
BTC Fee: ${fields.btc_fee}
${referrerLine}${refReturnLine}
By signing this message, you authorize the creation of a swap order with the above parameters.`
}

/**
 * The BIP322 text signed for an exact-input swap (`/swap`). A routed path adds a
 * `Route: a -> x -> b` line after the token addresses.
 */
export function swapOrderSignatureText(
  fields: SwapOrderTextFields & { in_amt: string; min_out_amt: string }
): string {
  return swapOrderText(
    `Input Amount: ${fields.in_amt}\nMinimum Output Amount: ${fields.min_out_amt}`,
    fields
  )
}

/**
 * The BIP322 text signed for an exact-output swap (`/swap2`). A routed path adds a
 * `Route: a -> x -> b` line after the token addresses.
 */
export function swap2OrderSignatureText(
  fields: SwapOrderTextFields & { max_in_amt: string; out_amt: string }
): string {
  return swapOrderText(
    `Maximum Input Amount: ${fields.max_in_amt}\nOutput Amount: ${fields.out_amt}`,
    fields
  )
}

/** The fields of the BLS swap message; `amount1`/`amount2` are the op's two amount words. */
export interface SwapBLSMessageFields {
  pubkey: string // no 0x
  nonce: bigint
  /** Token addresses from input to output; the direct path is `[token1, token2]`. */
  path: readonly string[]
  amount1: bigint
  amount2: bigint
  token1FeeBps: bigint
  token2FeeBps: bigint
  btc_fee: bigint
  referrer_pubkey?: string // no 0x
  ref_return_bps?: bigint
}

/**
 * The hex message hashed to the BLS curve and signed for a swap op: `03` for exact input (swap1)
 * with amounts (in_amt, min_out_amt), `04` for exact output (swap2) with (max_in_amt, out_amt).
 * Every path address is left-padded to 64 hex chars (the contract's address[] encoding), in path
 * order.
 */
export function swapBLSMessage(opType: '03' | '04', fields: SwapBLSMessageFields): string {
  let msg = ethers.keccak256(Buffer.from(fields.pubkey, 'hex')).slice(2)
  msg += fields.nonce.toString(16).padStart(8, '0')
  msg += opType
  for (const tokenAddr of fields.path) {
    msg += tokenAddr.slice(2).padStart(64, '0')
  }
  msg += fields.amount1.toString(16).padStart(64, '0')
  msg += fields.amount2.toString(16).padStart(64, '0')
  msg += fields.token1FeeBps.toString(16).padStart(64, '0')
  msg += fields.token2FeeBps.toString(16).padStart(64, '0')
  msg += fields.btc_fee.toString(16).padStart(64, '0')
  if (fields.referrer_pubkey) {
    msg += ethers.keccak256(Buffer.from(fields.referrer_pubkey, 'hex')).slice(2)
    msg += REFERRER_FEE_BPS.toString(16).padStart(8, '0')
    if (fields.ref_return_bps && fields.ref_return_bps > 0n) {
      msg += fields.ref_return_bps.toString(16).padStart(8, '0')
    }
  }
  return msg
}
