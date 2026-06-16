import type { BISWalletPurpose, PaymentOpts } from '../types/common'
import {
  callSmartContract as callSmartContractFromOrdinalsWallet,
  callSmartContractFromPaymentWallet,
  depositToBrc20Prog as depositToBrc20ProgCore,
  evmEncodeFunctionCall,
  withdrawFromBrc20Prog as withdrawFromBrc20ProgCore,
} from '../core/brc20'

/**
 * Interface representing the result of an inscription and send to OP_RETURN operation, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. This interface is used to encapsulate the details of the deploy, call and deposit operations in the BRC2.0 programmable module.
 *
 * @property {string} commitTxId - The transaction ID of the commit transaction created during the inscription process.
 * @property {string} revealTxId - The transaction ID of the reveal transaction created during the inscription process.
 * @property {string} signedCommitTxHex - The hexadecimal representation of the signed commit transaction, which can be broadcasted to the network to initiate the inscription process.
 * @property {string} signedRevealTxHex - The hexadecimal representation of the signed reveal transaction, which can be broadcasted to the network to complete the inscription process and transfer the BRC-20 tokens.
 * @property {string} inscriptionId - The unique identifier of the inscription created during the minting process, which can be used to track and reference the specific inscription associated with the deposit or withdrawal operation.
 * @property {number | null} postage - The amount of postage included in the minting transaction, specified in sats. This value may be null if no postage was included.
 * @property {string} secret - A secret value used in the minting process, which may be required for certain operations or for tracking the transaction. This value is typically generated during the minting process and can be used for verification or reference purposes.
 * @property {string} sendToOpReturnTxId - The transaction ID of the transaction created to send the BRC-20 tokens to the OP_RETURN output after the reveal transaction.
 * @property {string} signedSendToOpReturnTxHex - The hexadecimal representation of the signed transaction created to send the BRC-20 tokens to the OP_RETURN output, which can be broadcasted to the network after the reveal transaction.
 */
export interface InscribeAndSendToOpReturn {
  commitTxId: string
  revealTxId: string
  sendToOpReturnTxId: string
  signedCommitTxHex: string
  signedRevealTxHex: string
  signedSendToOpReturnTxHex: string
  inscriptionId: string
  postage: number | null
  secret: string
}

/**
 * Interface representing the result of an inscription and send to OP_RETURN operation, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. This interface is used to encapsulate the details of the withdrawal operations for BRC-20 tokens in the BRC2.0 programmable module.
 *
 * @property {string} commitTxId - The transaction ID of the commit transaction created during the inscription process.
 * @property {string} revealTxId - The transaction ID of the reveal transaction created during the inscription process.
 * @property {string} signedCommitTxHex - The hexadecimal representation of the signed commit transaction, which can be broadcasted to the network to initiate the inscription process.
 * @property {string} signedRevealTxHex - The hexadecimal representation of the signed reveal transaction, which can be broadcasted to the network to complete the inscription process and transfer the BRC-20 tokens.
 * @property {string} inscriptionId - The unique identifier of the inscription created during the minting process, which can be used to track and reference the specific inscription associated with the deposit or withdrawal operation.
 * @property {number | null} postage - The amount of postage included in the minting transaction, specified in sats. This value may be null if no postage was included.
 * @property {string} secret - A secret value used in the minting process, which may be required for certain operations or for tracking the transaction. This value is typically generated during the minting process and can be used for verification or reference purposes.
 * @property {string} transferTxId - The transaction ID of the transfer transaction created to send the BRC-20 tokens to the target address after the reveal transaction.
 * @property {string} signedTransferTxHex - The hexadecimal representation of the signed transfer transaction, which can be broadcasted to the network to transfer the BRC-20 tokens to the target address after the reveal transaction.
 */
export interface InscribeAndSendToAddress {
  commitTxId: string
  signedCommitTxHex: string
  revealTxId: string
  signedRevealTxHex: string
  inscriptionId: string
  postage: number | null
  secret: string
  transferTxId: string
  signedTransferTxHex: string
}

/**
 * Calls a smart contract on BRC2.0 using either an Ordinals wallet or a Payment wallet, depending on the specified wallet type. This function abstracts the logic for calling a smart contract and allows for flexibility in choosing the wallet type for the transaction.
 *
 * @param contractAddress The address of the smart contract to call.
 * @param calldataHex The calldata to send to the smart contract, encoded as a hexadecimal string.
 * @param estimatedGas The estimated amount of gas required for the transaction.
 * @param gasPerVbyte The gas cost per vbyte for the transaction.
 * @param feeRate The fee rate to use for the transaction, in satoshis per vbyte.
 * @param postage The amount of postage to include with the transaction, or null if no postage is needed.
 * @param dryRun A boolean indicating whether to perform a dry run of the transaction (i.e., simulate the transaction without actually sending it).
 * @param paymentOpts Optional extra payment output: when `paymentOpts.paymentAmount` is greater than 0, the transaction sends that many sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit, or pass a non-positive amount, for no extra payment.
 * @param walletType The type of wallet to use for the transaction, either 'payment' or 'ordinals'. If not specified, defaults to 'payment'.
 * @returns The result of the smart contract call, which may vary depending on the wallet type and the specifics of the transaction. The exact structure of the result will depend on the implementation of the callSmartContractFromOrdinalsWallet and callSmartContractFromPaymentWallet functions.
 * @throws An error if an unsupported wallet type is specified or if there is an issue with the smart contract call.
 */
export async function callSmartContract(
  contractAddress: string,
  calldataHex: string,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
  walletType?: BISWalletPurpose,
): Promise<InscribeAndSendToOpReturn> {
  if (!walletType || walletType === 'ordinals') {
    return await callSmartContractFromOrdinalsWallet(
      contractAddress,
      calldataHex,
      estimatedGas,
      gasPerVbyte,
      feeRate,
      postage,
      paymentOpts?.paymentAddress || null,
      paymentOpts?.paymentAmount || null,
      dryRun,
    )
  }
  else if (walletType === 'payment') {
    return await callSmartContractFromPaymentWallet(
      contractAddress,
      calldataHex,
      estimatedGas,
      gasPerVbyte,
      feeRate,
      postage,
      paymentOpts?.paymentAddress || null,
      paymentOpts?.paymentAmount || null,
      dryRun,
    )
  }
  else {
    throw new Error(`Unsupported wallet type: ${walletType}`)
  }
}

/**
 * Calls a smart contract function by encoding the function call with the provided ABI, function name, and parameters, and then invoking the callSmartContract function to execute the transaction. This function serves as a higher-level abstraction for calling smart contract functions, allowing developers to specify the function and parameters in a more intuitive way without needing to manually encode the calldata.
 *
 * @param contractAddress The address of the smart contract to call.
 * @param abi The ABI (Application Binary Interface) of the smart contract, which defines the functions and their parameters for encoding the function call.
 * @param funcName The name of the function to call on the smart contract, which should be defined in the provided ABI.
 * @param params The parameters to pass to the smart contract function, which should be provided as an array and will be encoded according to the ABI specifications.
 * @param estimatedGas The estimated amount of gas required for the transaction, which is used to calculate the transaction fee and ensure that sufficient funds are available for the transaction to be processed.
 * @param gasPerVbyte The gas cost per vbyte for the transaction, which is used in conjunction with the estimated gas to calculate the total transaction fee.
 * @param feeRate The fee rate to use for the transaction, in satoshis per vbyte, which is used to calculate the total transaction fee based on the estimated gas and gas cost per vbyte.
 * @param postage The amount of postage to include with the transaction, or null if no postage is needed. Postage may be required for certain transactions to ensure that they are processed in a timely manner, especially during periods of high network congestion.
 * @param dryRun A boolean indicating whether to perform a dry run of the transaction (i.e., simulate the transaction without actually sending it). This can be useful for testing and debugging purposes to ensure that the function call is correctly encoded and that the transaction would succeed before actually sending it to the network.
 * @param paymentOpts Optional extra payment output: when `paymentOpts.paymentAmount` is greater than 0, the transaction sends that many sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit, or pass a non-positive amount, for no extra payment.
 * @param walletType The type of wallet to use for the transaction, either 'payment' or 'ordinals'. This parameter allows the caller to specify which wallet implementation to use when executing the smart contract call, providing flexibility in how the transaction is processed based on the capabilities and requirements of the chosen wallet type.
 * @returns The result of the smart contract call, which may vary depending on the wallet type and the specifics of the transaction. The exact structure of the result will depend on the implementation of the callSmartContractFromOrdinalsWallet and callSmartContractFromPaymentWallet functions, as well as the nature of the smart contract being called and the function being invoked.
 * @throws An error if the ABI is not an object, if the function name is not a string, if the parameters are not an array, if an unsupported wallet type is specified, or if there is an issue with the smart contract call.
 */
export async function callSmartContractAbi(
  contractAddress: string,
  abi: any,
  funcName: string,
  params: any,
  estimatedGas: number,
  gasPerVbyte: number,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
  walletType?: BISWalletPurpose,
): Promise<InscribeAndSendToOpReturn> {
  if (typeof abi != 'object')
    throw new Error('abi must be an object')
  if (typeof funcName != 'string')
    throw new Error('func_name must be a string')
  if (!Array.isArray(params))
    throw new Error('params must be an array')

  const walletTypeString = walletType || 'payment'

  const encodedFuncCall = evmEncodeFunctionCall(abi, funcName, params)
  return await callSmartContract(
    contractAddress,
    encodedFuncCall,
    estimatedGas,
    gasPerVbyte,
    feeRate,
    postage,
    dryRun,
    paymentOpts,
    walletTypeString,
  )
}

/**
 * Deposits a BRC-20 token into the BRC2.0 programmable module by creating an inscription with the transfer operation and sending it to the OP_RETURN output. The function takes the token tick, amount, fee rate, and optional payment parameters, creates an inscription with the transfer operation, mints it, and then sends it to an OP_RETURN output with a specific format. It also allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param tick - The tick of the BRC-20 token to be deposited, represented as a string. This will be included in the inscription content to indicate which token is being transferred.
 * @param amount - The amount of the BRC-20 token to be deposited, represented as a string. This will be included in the inscription content to indicate how many tokens are being transferred.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the deposit process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 * @param paymentOpts - Optional extra payment output: when `paymentOpts.paymentAmount` is greater than 0, the transaction sends that many sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit, or pass a non-positive amount, for no extra payment.
 *
 * @returns An object containing details of the deposit process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function depositToBrc20Prog(
  tick: string,
  amount: string,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeAndSendToOpReturn> {
  return await depositToBrc20ProgCore(
    tick,
    amount,
    feeRate,
    postage,
    paymentOpts?.paymentAddress || null,
    paymentOpts?.paymentAmount || null,
    dryRun,
  )
}

/**
 * Withdraws a BRC-20 token from the BRC2.0 programmable module by creating an inscription with the transfer operation and sending it to the OP_RETURN output. The function takes the token tick, amount, target address, fee rate, and optional payment parameters, creates an inscription with the transfer operation, mints it, and then sends it to an OP_RETURN output with a specific format. It also allows for a dry run mode where the transaction hexes are returned without broadcasting.
 *
 * @param tick - The tick of the BRC-20 token to be withdrawn, represented as a string. This will be included in the inscription content to indicate which token is being transferred.
 * @param amount - The amount of the BRC-20 token to be withdrawn, represented as a string. This will be included in the inscription content to indicate how many tokens are being transferred.
 * @param targetAddress - The Bitcoin address to which the withdrawn tokens should be sent. This will be included in the inscription content to indicate the recipient of the tokens.
 * @param feeRate - The fee rate in sats/vbyte to be used for the transactions involved in the withdrawal process.
 * @param postage - An optional parameter representing the postage to be included in the minting transaction, specified in sats. If null, no postage will be included.
 * @param dryRun - A boolean flag indicating whether to perform a dry run. If true, the function will return the transaction hexes without broadcasting them to the network. If false, the transactions will be broadcasted after creation.
 * @param paymentOpts - Optional extra payment output: when `paymentOpts.paymentAmount` is greater than 0, the transaction sends that many sats to `paymentOpts.paymentAddress` (funded by the connected wallet — e.g. a service fee). Omit, or pass a non-positive amount, for no extra payment.
 *
 * @returns An object containing details of the withdrawal process, including transaction IDs, signed transaction hexes, inscription ID, postage, and secret used in the minting process. If dryRun is true, the transactions will not be broadcasted and the hexes will be returned for inspection.
 */
export async function withdrawFromBrc20Prog(
  tick: string,
  amount: string,
  targetAddress: string,
  feeRate: number,
  postage: number | null,
  dryRun: boolean,
  paymentOpts?: PaymentOpts,
): Promise<InscribeAndSendToAddress> {
  return await withdrawFromBrc20ProgCore(
    tick,
    amount,
    targetAddress,
    feeRate,
    postage,
    paymentOpts?.paymentAddress || null,
    paymentOpts?.paymentAmount || null,
    dryRun,
  )
}
