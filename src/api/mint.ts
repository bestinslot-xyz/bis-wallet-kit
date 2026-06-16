import type { PaymentOpts } from '../types/common'
import type {
  InscribeFees,
  InscribeMultipleResult,
  InscribeResult,
  InscriptionDetails,
} from '../types/inscription'
import {
  getInscribeMultipleFee as getInscribeMultipleFeeCore,
  inscribeMultiple as inscribeMultipleCore,
  inscribeWithParent as inscribeWithParentCore,
} from '../core/mint'

export type { InscribeFees, InscribeMultipleResult, InscribeResult, InscriptionDetails }

/**
 * Inscribe an inscription with the given details, fee rate, postage, and payment options. This function performs the inscription process for a single inscription. The function returns the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription ID, postage, and secret used for the inscription.
 *
 * @param inscriptionDetails - An InscriptionDetails instance containing the details of the inscription to be minted.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the inscription transactions.
 * @param postage - The postage amount in satoshis to be included in the inscription transactions, or null to use the default dust value.
 * @param dryRun - A boolean indicating whether to perform a dry run of the inscription, which will return the transaction details without broadcasting them to the network.
 * @param paymentOpts - Optional extra payment output added to the transaction: sends `paymentOpts.paymentAmount` sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit for no extra payment.
 * @returns A promise that resolves to an object containing the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription IDs, postage, and secret used for the inscriptions.
 */
export async function inscribe(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeResult> {
  const result = await inscribeMultipleCore(
    [inscriptionDetails],
    feeRate,
    postage,
    dryRun,
    paymentOpts,
  )
  return {
    commitTxId: result.commitTxId,
    signedCommitTxHex: result.signedCommitTxHex,
    revealTxId: result.revealTxId,
    signedRevealTxHex: result.signedRevealTxHex,
    inscriptionId: result.inscriptionIds[0]!,
    postage: result.postage,
    secret: result.secret,
  }
}

/**
 * Inscribe multiple inscriptions with the given details, fee rate, postage, and payment options. This function performs the inscription process for multiple inscriptions in a single batch, which can be more efficient than inscribing them individually. The function returns the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription IDs, postage, and secret used for the inscriptions.
 *
 * @param inscriptionDetailsArray - An array of InscriptionDetails instances containing the details of each inscription to be minted.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the inscription transactions.
 * @param postage - The postage amount in satoshis to be included in the inscription transactions, or null to use the default dust value.
 * @param dryRun - A boolean indicating whether to perform a dry run of the inscription, which will return the transaction details without broadcasting them to the network.
 * @param paymentOpts - Optional extra payment output added to the transaction: sends `paymentOpts.paymentAmount` sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit for no extra payment.
 * @returns A promise that resolves to an object containing the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription IDs, postage, and secret used for the inscriptions.
 */
export async function inscribeMultiple(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeMultipleResult> {
  return await inscribeMultipleCore(inscriptionDetailsArray, feeRate, postage, dryRun, paymentOpts)
}

/**
 * Inscribe an inscription with a parent inscription by providing the details of the inscription, the parent inscription ID, fee rate, postage, and payment options. This function allows for creating a new inscription that is linked to an existing parent inscription, which can be useful for creating a series of related inscriptions or for building more complex inscription structures. The function returns the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription ID, postage, and secret used for the inscription.
 *
 * @param inscriptionDetails - An InscriptionDetails instance containing the details of the inscription to be minted.
 * @param parentInscriptionId - The ID of the parent inscription to which the new inscription will be linked.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the inscription transactions.
 * @param postage - The postage amount in satoshis to be included in the inscription transactions, or null to use the default dust value.
 * @param dryRun - A boolean indicating whether to perform a dry run of the inscription, which will return the transaction details without broadcasting them to the network.
 * @param paymentOpts - Optional extra payment output added to the transaction: sends `paymentOpts.paymentAmount` sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit for no extra payment.
 * @returns A promise that resolves to an object containing the transaction IDs and signed transaction hex for both the commit and reveal transactions, as well as the inscription ID, postage, and secret used for the inscription.
 * @throws Will throw an error if the inscription process fails for any reason, such as invalid input parameters, insufficient funds for fees, or issues with the parent inscription. The error message will provide details about the reason for the failure.
 */
export async function inscribeWithParent(
  inscriptionDetails: InscriptionDetails,
  parentInscriptionId: string,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeResult> {
  return await inscribeWithParentCore(
    inscriptionDetails,
    parentInscriptionId,
    feeRate,
    postage,
    dryRun,
    paymentOpts,
  )
}

/**
 * Get the fee estimates for inscribing an inscription with the given details, fee rate, postage, and payment options. This function returns the estimated fees for both the commit and reveal transactions, as well as the total fee for the inscription process.
 * @param inscriptionDetails - An InscriptionDetails instance containing the details of the inscription to be minted.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the inscription transactions.
 * @param postage - The postage amount in satoshis to be included in the inscription transactions, or null to use the default dust value.
 * @param paymentOpts - Optional extra payment output added to the transaction: sends `paymentOpts.paymentAmount` sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit for no extra payment.
 * @returns A promise that resolves to an object containing the estimated fees for both the commit and reveal transactions, as well as the total fee for the inscription process.
 */
export async function getInscribeFee(
  inscriptionDetails: InscriptionDetails,
  feeRate: number,
  postage: number | null,
  paymentOpts?: PaymentOpts,
): Promise<InscribeFees> {
  return await getInscribeMultipleFeeCore([inscriptionDetails], feeRate, postage, paymentOpts)
}

/**
 * Get the fee estimates for inscribing multiple inscriptions with the given details, fee rate, postage, and payment options. This function returns the estimated fees for both the commit and reveal transactions, as well as the total fee for the inscription process for multiple inscriptions in a single batch.
 *
 * @param inscriptionDetailsArray - An array of InscriptionDetails instances containing the details of each inscription to be minted.
 * @param feeRate - The fee rate in satoshis per virtual byte to be used for the inscription transactions.
 * @param postage - The postage amount in satoshis to be included in the inscription transactions, or null to use the default dust value.
 * @param paymentOpts - Optional extra payment output added to the transaction: sends `paymentOpts.paymentAmount` sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit for no extra payment.
 * @returns A promise that resolves to an object containing the estimated fees for both the commit and reveal transactions, as well as the total fee for the inscription process for multiple inscriptions in a single batch.
 */
export async function getInscribeMultipleFee(
  inscriptionDetailsArray: InscriptionDetails[],
  feeRate: number,
  postage: number | null,
  paymentOpts?: PaymentOpts,
): Promise<InscribeFees> {
  return await getInscribeMultipleFeeCore(inscriptionDetailsArray, feeRate, postage, paymentOpts)
}
