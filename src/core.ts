/* eslint-disable perfectionist/sort-exports */

// Framework-agnostic browser entry: extension providers + all feature APIs, but
// NO Vue and NO DOM modal. Intended as the base for the React/Vue adapters and
// for consumers that render their own connect UI.

import './core/register-browser-providers'

export * as wallet from './api/wallet' // shared surface (no modal connect/disconnect)
export * as swap from './api/swap'
export * as brc20 from './api/brc20'
export * as mint from './api/mint'
export * as balances from './api/balances'
export * from './api/helpers'

// Network store (framework-agnostic) for adapters and headless consumers.
export { getNetwork, setNetwork, subscribeToNetwork } from './core/store-network'

export type { PaymentOpts } from './types/common'

export * as bitcoinjs from 'bitcoinjs-lib'
export * as Buff from '@cmdcode/buff-utils'
