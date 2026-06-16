import type { BISSession } from '../types/common'
import { create, hide, showConnect } from './modal'
import { clearWalletInfo } from './store'

// Modal-driven connect flow. Browser-only: it imports the Vue modal. The server
// build connects via the local wallet (connectLocalWallet) instead, so it does
// not include this module.

/**
 * Creates the modal instance without showing it.
 */
export function init() {
  create()
}

/**
 * Shows the connect modal and resolves with the selected wallet session.
 *
 * @returns A promise that resolves with the session when a wallet connects, or rejects on error.
 */
export async function connect(): Promise<BISSession> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new TypeError(
      'Modal connect is only available in the browser. Use connectLocalWallet in a Node environment.',
    )
  }

  // Ensure the modal exists (idempotent) so showConnect isn't a silent no-op
  // that leaves the promise pending forever.
  create()

  return new Promise((resolve, reject) => {
    showConnect({
      onSelect: (session: BISSession) => resolve(session),
      onError: (error: Error) => reject(error),
    })
  })
}

/**
 * Disconnects the current wallet: hides the modal and clears the stored session.
 */
export function disconnect() {
  hide()
  clearWalletInfo()
}
