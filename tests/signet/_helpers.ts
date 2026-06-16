import process from 'node:process'
import { wallet } from '../../src/node.ts'

/**
 * Shared setup + fixtures for the signet integration suite.
 *
 * Everything is driven by environment variables (loaded from `.env.signet` via
 * the vitest config). Tests `skipIf` when the fixtures they need aren't set, so
 * the suite runs as far as the configured environment allows and skips the rest.
 *
 * Fund-moving tests additionally require `SIGNET_EXECUTE=1` so reads can't
 * accidentally trigger on-chain activity.
 */

export function requireWif(): string {
  const wif = process.env.PRIVATE_KEY_WIF
  if (!wif) {
    throw new Error('PRIVATE_KEY_WIF environment variable is not set')
  }
  return wif
}

/** Connects the local (WIF) wallet on signet as a p2tr wallet. */
export async function connectSignetWallet() {
  return wallet.connectLocalWallet(requireWif(), 'signet', 'p2tr', 'unisat')
}

export const env = {
  /** Master switch for fund-moving (on-chain) tests. */
  execute: process.env.SIGNET_EXECUTE === '1',

  /** A swap-enabled token address (the non-WBTC side of a pair). */
  swapToken: process.env.SIGNET_SWAP_TOKEN,
  /** The WBTC token address on signet. */
  wbtcToken: process.env.SIGNET_WBTC_TOKEN,
  /** A pair address (e.g. swapToken / WBTC). */
  swapPair: process.env.SIGNET_SWAP_PAIR,
  /** A referral ID that resolves to a referrer other than the test wallet. */
  referrerId: process.env.SIGNET_REFERRER_ID,
  /** A base BRC-20 token address for balance lookups. */
  baseBrc20Token: process.env.SIGNET_BASE_BRC20_TOKEN,
  /** A deployed BRC-2.0 contract address for smart-contract calls. */
  contractAddress: process.env.SIGNET_CONTRACT_ADDRESS,

  /** Small input amount used for swap/deposit execution tests. */
  swapAmount: BigInt(process.env.SIGNET_SWAP_AMOUNT ?? '1000'),
  /** Slippage tolerance (bps) for execution tests. */
  slippageBps: BigInt(process.env.SIGNET_SLIPPAGE_BPS ?? '100'),
}

/** True when both swap-pair token sides are configured. */
export const hasSwapTokens = Boolean(env.swapToken && env.wbtcToken)
