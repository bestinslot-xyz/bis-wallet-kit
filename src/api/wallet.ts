import type { LocalWalletSource, LocalWalletType } from '../provider/local'
import type { WalletInfo } from '../types/wallet'

export { connect, disconnect } from '../core/connect-modal' // Modal-driven connect flow (browser-only)
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
export { saveWallet as connectLocalWallet } from '../provider/local' // Export local wallet provider functions

// Re-export wallet-related types
export type { WalletInfo }
export type { LocalWalletSource, LocalWalletType }
export type {
  BISNetwork,
  BISSession,
  BISWallet,
  BISWalletProvider,
  BISWalletPurpose,
} from '../types/common'
export type { SendInscriptionResult } from '../types/inscription'
