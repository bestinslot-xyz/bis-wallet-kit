import type { BISSession } from '../main'
import { modal } from '../core/modal'
import { clearWalletInfo } from './store'

export { getAllBalanceDetails, getCardinalBalance } from './helpers'
export {
  getOrdinalsWallet,
  getPaymentWallet,
  sendBTC,
  signMessage,
  signMessageLocalVerify,
  signMessageLocalVerifyDeterministic,
} from './providers'
export { getWalletInfo as getSession } from './store'
export { getNetwork, setNetwork } from './store-network'

/**
 * Creates a modal instance without showing it.
 */
export function init() {
  // Create the modal instance
  modal.create()
}

/**
 * Shows the connect modal and returns a promise that resolves with the selected wallet session information.
 *
 * The promise will resolve when the user selects a wallet and successfully connects, or it will reject if
 * there is an error during the connection process.
 *
 * @returns {Promise<BISSession>} A promise that resolves with the wallet session information when a wallet is successfully connected.
 * @throws {Error} If there is an error during the connection process, the promise will reject with an error object.
 */
export async function connect(): Promise<BISSession> {
  return new Promise((resolve, reject) => {
    modal.showConnect({
      onSelect: (session: BISSession) => resolve(session),
      onError: (error: Error) => reject(error),
    })
  })
}

/**
 * Disconnects the currently connected wallet by hiding the modal and clearing the stored wallet information.
 */
export function disconnect() {
  // Close modal
  modal.hide()

  // Clear local storage
  clearWalletInfo()
}
