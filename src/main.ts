/* eslint-disable perfectionist/sort-exports */

// -------- Wallet API --------
export * as wallet from './api/wallet'

// -------- Modal API --------
export * as modal from './api/modal'

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

// Set up dev mode
if (import.meta.env.DEV && typeof document !== 'undefined') {
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
