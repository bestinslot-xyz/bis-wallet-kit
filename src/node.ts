/* eslint-disable perfectionist/sort-exports */

// Server (Node/Bun) build entry: the shared feature APIs plus the local (WIF)
// wallet. No Vue, no modal, no extension providers — suitable for headless and
// automated use (e.g. running swaps and inscriptions from a backend).

// -------- Provider registration (side effects) --------
import './core/register-local-provider'

// -------- Wallet API (shared core + local wallet) --------
export * as wallet from './api/wallet.node'

// -------- Swap API --------
export * as swap from './api/swap'

// -------- BRC20 API --------
export * as brc20 from './api/brc20'

// -------- Mint API --------
export * as mint from './api/mint'

// -------- Balances API --------
export * as balances from './api/balances'

// -------- Helpers API --------
export * from './api/helpers'

// -------- Common types -------
export type { PaymentOpts } from './types/common'

// ---- Re-exports ----
export * as bitcoinjs from 'bitcoinjs-lib'
export * as Buff from '@cmdcode/buff-utils'
