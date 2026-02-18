import type { BISSession } from '../main'
import { modal } from '../core/modal'
import { clearWalletInfo } from './store'

export { getAllBalanceDetails, getCardinalBalance } from './helpers'
export { getOrdinalsWallet, getPaymentWallet, sendBTC, signMessage, signMessageLocalVerify, signMessageLocalVerifyDeterministic } from './providers'
export { getWalletInfo as getSession } from './store'
export { getNetwork, setNetwork } from './store-network'

export const setTheme = modal.setTheme

export function init() {
  // Create the modal instance
  modal.create()
}

export async function connect(): Promise<BISSession> {
  return new Promise((resolve, reject) => {
    modal.showConnect({
      onSelect: (session: BISSession) => resolve(session),
      onError: (error: Error) => reject(error),
    })
  })
}

export function disconnect() {
  // Close modal
  modal.hide()

  // Clear local storage
  clearWalletInfo()
}
