import type { BISSession, BISWalletPurpose } from '../types/common'
import type { SendInscriptionResult } from '../types/inscription'
import type { WalletInfo } from '../types/wallet'
import { create, hide, showConnect } from '../core/modal'
import { sendInscriptionAll, sendInscriptionInPaymentWalletToOpReturnAll, sendInscriptionToOpReturnAll } from './mint'
import { getSignFn } from './providers'
import { clearWalletInfo, getWalletInfo } from './store'

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
  create()
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
    showConnect({
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
  hide()

  // Clear local storage
  clearWalletInfo()
}

/**
 * Sends an inscription to a target wallet with the specified postage, fee rate, and dry run option. The function determines the appropriate method for sending the inscription based on the target wallet's properties and the specified wallet type. It uses the provided signing function to sign the necessary transactions for sending the inscription.
 *
 * @param inscriptionId - The ID of the inscription to be sent.
 * @param targetWallet - An object containing information about the target wallet, including its address and whether it is an OP_RETURN wallet.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the transaction.
 * @param postage - The amount of postage in satoshis to be included in the transaction for sending the inscription.
 * @param dryRun - A boolean indicating whether to perform a dry run of the transaction, which will return the transaction details without broadcasting it to the network.
 * @param walletType - An optional parameter specifying the type of wallet to use for sending the inscription, which can affect the method used for sending. If not provided, the function will determine the method based on the target wallet's properties.
 * @returns A promise that resolves with the result of the send operation, which may include transaction details or an error if the operation fails.
 * @throws Will throw an error if there is no wallet currently connected, if the target wallet type is unsupported, or if there is an issue with the signing function.
 * @remarks The function uses different methods for sending the inscription based on whether the target wallet is an OP_RETURN wallet and the specified wallet type. It also ensures that a wallet is currently connected before attempting to send the inscription.
 */
export async function sendInscription(
  inscriptionId: string,
  targetWallet: WalletInfo,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  walletType?: BISWalletPurpose,
): Promise<SendInscriptionResult> {
  const currentWalletInfo = getWalletInfo()
  if (!currentWalletInfo) {
    throw new Error('No wallet connected')
  }

  const signFn = getSignFn(currentWalletInfo.provider)

  if (targetWallet.isOpReturn) {
    if (!walletType || walletType === 'ordinals') {
      return await sendInscriptionToOpReturnAll(inscriptionId, targetWallet, postage, feeRate, dryRun, signFn)
    }
    else if (walletType === 'payment') {
      return await sendInscriptionInPaymentWalletToOpReturnAll(inscriptionId, targetWallet, postage, feeRate, dryRun, signFn)
    }
  }
  if (!walletType || walletType === 'ordinals') {
    return await sendInscriptionAll(inscriptionId, targetWallet, postage, feeRate, dryRun, signFn)
  }
  else {
    throw new Error(`Unsupported wallet type: ${walletType}`)
  }
}
