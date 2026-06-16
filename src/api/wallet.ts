import type { WalletInfo } from '../types/wallet'

// Shared wallet surface, present in both the browser and server builds. The
// connection method differs per flavour and is added by the entry-specific
// wallet modules: `wallet.browser.ts` adds the modal connect/disconnect,
// `wallet.node.ts` adds connectLocalWallet.
export {
  getAllBalanceDetails,
  getCardinalBalance,
  getOrdinalsWallet,
  getPaymentWallet,
  getSession,
  sendBTC,
  sendInscription,
  setNetwork,
  signMessage,
  signMessageLocalVerify,
  signMessageLocalVerifyDeterministic,
} from '../core/bis' // Export all wallet-related functions from the core BIS module
export { getNetwork } from '../core/store-network' // Read the currently selected network (mirror of setNetwork)

// Re-export wallet-related types
export type { WalletInfo }
export type {
  BISNetwork,
  BISSession,
  BISWallet,
  BISWalletProvider,
  BISWalletPurpose,
} from '../types/common'
export type { SendInscriptionResult } from '../types/inscription'
