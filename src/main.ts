/* eslint-disable perfectionist/sort-exports */

// -------- Wallet API --------
export * as wallet from './core/bis'

// -------- Modal API --------
export * as modal from './core/modal'

// -------- Swap API --------
export * as swap from './core/bis_swap'

// -------- BRC20 API --------
export * as brc20 from './core/brc20'

// -------- Mint API --------
export * as mint from './core/mint'

// -------- Balances API --------
export * as balances from './core/balances'

// ---- Types ----
export type { BISSwapWalletInfo as SwapWalletInfo } from './core/store'

export type { LocalWalletSource, LocalWalletType } from './provider/local'

export type {
  BISNetwork,
  BISSession,
  BISWallet,
  BISWalletProvider,
  BISWalletPurpose,
  ConnectCallbacks,
  ModalTheme,
} from './types/common'

// ---- Re-exports ----
export * as bitcoinjs from 'bitcoinjs-lib'
export * as Buff from '@cmdcode/buff-utils'

// Set up dev mode
if (import.meta.env.DEV) {
  // Mount Vue
  Promise.all([
    import('vue'),
    import('./components/Dev.vue'),
    import('./assets/dev/favicon.ico'),
  ]).then(([{ createApp }, { default: devTest }, faviconModule]) => {
    const app = createApp(devTest)
    app.mount('#app')

    // Set favicon
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.href = faviconModule.default
    document.head.appendChild(favicon)
  })
}
