import type { BISProvider, SignFunction } from '../provider/api'
import type { BISSession, BISWallet, BISWalletProvider, BISWalletPurpose } from '../types/common'
import { LEATHER } from '../provider/leather'
import { LOCAL } from '../provider/local'
import { ME } from '../provider/me'
import { OKX } from '../provider/okx'
import { UNISAT } from '../provider/unisat'
import { XVERSE } from '../provider/xverse'
import { verifySignature, verifySignatureLocal } from './helpers'
import { getWalletInfo, saveWalletInfo } from './store'

export const PROVIDERS: Record<string, BISProvider> = {
  leather: LEATHER,
  me: ME,
  okx: OKX,
  unisat: UNISAT,
  xverse: XVERSE,
  local: LOCAL,
} as const

type ProviderKey = keyof typeof PROVIDERS

// const allowedProviders = Object.keys(providers)

/**
 * Gets the list of wallets from the specified provider. The function checks if the provider is supported and then calls the corresponding getWallets function from the provider module to retrieve the list of wallets. If the provider is not supported or if there is an error while fetching the wallets, it throws an error with an appropriate message.
 *
 * @param provider The wallet provider for which to fetch the wallets. This should be one of the supported providers defined in the PROVIDERS object.
 *
 * @returns A promise that resolves to a BISSession object containing the provider, the list of wallets, and a null signature. The function also saves the wallet information to local storage for later use.
 * @throws An error if the provider is not supported or if there is an error while fetching the wallets, with a message indicating the reason for the failure.
 */
export async function getWallets(provider: BISWalletProvider): Promise<BISSession> {
  // Get wallets
  const wallets = await PROVIDERS[provider as ProviderKey]?.getWallets().catch((err: any) => {
    console.error('Failed to get wallets.', err)

    throw new Error(err?.message || 'Failed to get wallets.')
  })

  if (!wallets)
    throw new Error('Failed to get wallets.')

  const resp: BISSession = {
    provider,
    wallets,
    signature: null,
  }

  // Save local storage
  saveWalletInfo(resp)

  return resp
}

function getWallet(walletType: BISWalletPurpose): BISWallet | undefined {
  const walletInfo = getWalletInfo()

  if (!walletInfo) {
    console.error('Wallet not found.')

    return undefined
  }

  const wallets = walletInfo.wallets
  const provider = walletInfo.provider

  const singleWalletProviders = ['okx', 'unisat', 'local']

  if (singleWalletProviders.includes(provider)) {
    walletType = 'all'
  }

  const wallet = wallets.find(wallet => wallet.purpose === walletType)

  if (!wallet) {
    console.error(`${walletType} wallet not found. Provider: ${walletInfo.provider}`)

    return undefined
  }

  return wallet
}

/**
 * Returns the currently connected ordinals wallet, or undefined if no ordinals wallet is connected. The function retrieves the wallet information from local storage and checks for a wallet with the purpose of 'ordinals'. If such a wallet is found, it is returned; otherwise, the function returns undefined.
 *
 * @returns The currently connected ordinals wallet, or undefined if no ordinals wallet is connected.
 */
export function getOrdinalsWallet(): BISWallet | undefined {
  return getWallet('ordinals')
}

/**
 * Returns the currently connected payment wallet, or undefined if no payment wallet is connected. The function retrieves the wallet information from local storage and checks for a wallet with the purpose of 'payment'. If such a wallet is found, it is returned; otherwise, the function returns undefined.
 *
 * @returns The currently connected payment wallet, or undefined if no payment wallet is connected.
 */
export function getPaymentWallet(): BISWallet | undefined {
  return getWallet('payment')
}

/**
 * Returns the sign function for the currently connected wallet provider. The function checks the provider from the wallet information stored in local storage and returns the corresponding sign function from the PROVIDERS object. If the provider is not found or if there is an error while retrieving the sign function, it throws an error with an appropriate message.
 *
 * @param provider The wallet provider for which to get the sign function. This should be one of the supported providers defined in the PROVIDERS object.
 * @returns The sign function corresponding to the specified provider, which can be used to sign PSBTs for transactions. The function returns a promise that resolves to a SignResponse object containing the transaction ID and the signed transaction hex.
 * @throws An error if the provider is not found or if there is an error while retrieving the sign function, with a message indicating the reason for the failure.
 */
export function getSignFn(provider: BISWalletProvider): SignFunction {
  if (!PROVIDERS[provider as ProviderKey]) {
    throw new Error('Unknown provider')
  }

  return PROVIDERS[provider as ProviderKey]!.sign
}

/**
 * Signs a message using the currently connected wallet provider. The function retrieves the provider from the wallet information stored in local storage and calls the corresponding signMessage function from the PROVIDERS object to sign the message. After signing, it verifies the signature using either the verifySignature or verifySignatureLocal function from the helpers module, depending on the context. If the signature is valid, it returns the signature; otherwise, it throws an error indicating that signature verification failed.
 *
 * @param message The message to be signed by the wallet provider. This is typically a string that represents some data that the user needs to sign for authentication or transaction purposes.
 * @param walletType The type of wallet for which to sign the message. This can be either 'payment' or 'ordinals', depending on the purpose of the wallet being used for signing.
 * @returns A promise that resolves to the signature string if the signing and verification processes are successful, or throws an error if there is a failure in signing or if the signature verification fails.
 * @throws An error if there is a failure in signing the message or if the signature verification fails, with a message indicating the reason for the failure.
 */
export async function signMessage(message: string, walletType: BISWalletPurpose): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signature: string | undefined

  const wallet = getWallet(walletType)

  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  if (provider === 'unisat') {
    signature = await UNISAT.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'xverse') {
    signature = await XVERSE.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'leather') {
    signature = await LEATHER.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'me') {
    signature = await ME.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'okx') {
    signature = await OKX.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'local') {
    signature = await LOCAL.signMessage(message, walletType, wallet.address)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!verifySignature(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

/**
 * Signs a message using the currently connected wallet provider and verifies the signature locally. The function retrieves the provider from the wallet information stored in local storage and calls the corresponding signMessage function from the PROVIDERS object to sign the message. After signing, it verifies the signature using the verifySignatureLocal function from the helpers module. If the signature is valid, it returns the signature; otherwise, it throws an error indicating that signature verification failed.
 *
 * @param message The message to be signed by the wallet provider. This is typically a string that represents some data that the user needs to sign for authentication or transaction purposes.
 * @param walletType The type of wallet for which to sign the message. This can be either 'payment' or 'ordinals', depending on the purpose of the wallet being used for signing.
 * @returns A promise that resolves to the signature string if the signing and local verification processes are successful, or throws an error if there is a failure in signing or if the signature verification fails.
 * @throws An error if there is a failure in signing the message or if the signature verification fails, with a message indicating the reason for the failure.
 */
export async function signMessageLocalVerify(
  message: string,
  walletType: BISWalletPurpose,
): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signature: string | undefined

  const wallet = getWallet(walletType)

  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  if (provider === 'unisat') {
    signature = await UNISAT.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'xverse') {
    signature = await XVERSE.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'leather') {
    signature = await LEATHER.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'me') {
    signature = await ME.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'okx') {
    signature = await OKX.signMessage(message, walletType, wallet.address)
  }
  else if (provider === 'local') {
    signature = await LOCAL.signMessage(message, walletType, wallet.address)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!verifySignatureLocal(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

/**
 * Signs a message using the currently connected wallet provider and verifies the signature locally using a deterministic signing method. The function retrieves the provider from the wallet information stored in local storage and calls the corresponding signMessageDeterministic function from the PROVIDERS object to sign the message. After signing, it verifies the signature using the verifySignatureLocal function from the helpers module. If the signature is valid, it returns the signature; otherwise, it throws an error indicating that signature verification failed.
 *
 * @param message The message to be signed by the wallet provider. This is typically a string that represents some data that the user needs to sign for authentication or transaction purposes.
 * @returns A promise that resolves to the signature string if the signing and local verification processes are successful, or throws an error if there is a failure in signing or if the signature verification fails.
 * @throws An error if there is a failure in signing the message or if the signature verification fails, with a message indicating the reason for the failure.
 */
export async function signMessageLocalVerifyDeterministic(message: string): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signatureRes: { signature: string, address: string } | undefined

  if (provider === 'unisat') {
    signatureRes = await UNISAT.signMessageDeterministic(message)
  }
  else if (provider === 'xverse') {
    signatureRes = await XVERSE.signMessageDeterministic(message)
  }
  else if (provider === 'leather') {
    signatureRes = await LEATHER.signMessageDeterministic(message)
  }
  else if (provider === 'me') {
    signatureRes = await ME.signMessageDeterministic(message)
  }
  else if (provider === 'okx') {
    signatureRes = await OKX.signMessageDeterministic(message)
  }
  else if (provider === 'local') {
    signatureRes = await LOCAL.signMessageDeterministic(message)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!signatureRes) {
    console.error('Signature result not found.')
    throw new Error('Signature result not found.')
  }

  if (!verifySignatureLocal(message, signatureRes.signature, signatureRes.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signatureRes.signature
}

/**
 * Sends Bitcoin using the currently connected wallet provider. The function retrieves the provider from the wallet information stored in local storage and calls the corresponding sendBTC function from the PROVIDERS object to send the specified amount of Bitcoin to the given address. If the transaction is successful, it returns the transaction ID (txid) of the sent transaction; otherwise, it throws an error indicating that sending Bitcoin failed.
 *
 * @param amountSats The amount of Bitcoin to send in satoshis. This value will be sent to the provider to initiate the transaction.
 * @param toAddress The address to which the Bitcoin should be sent. This value will be sent to the provider along with the amount to initiate the transaction.
 *
 * @returns A promise that resolves to the transaction ID (txid) of the sent transaction as a string. This allows developers to track the transaction on the blockchain. If there is an error in sending the Bitcoin, the promise will be rejected with a descriptive error message.
 */
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  const provider = getWalletInfo()?.provider
  let txid: string | undefined

  if (provider === 'unisat') {
    txid = await UNISAT.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'xverse') {
    txid = await XVERSE.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'leather') {
    txid = await LEATHER.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'me') {
    txid = await ME.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'okx') {
    txid = await OKX.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'local') {
    txid = await LOCAL.sendBTC(amountSats, toAddress)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!txid) {
    console.error('Send BTC result not found.')
    throw new Error('Send BTC error.')
  }

  return txid
}

/**
 * Signs a PSBT (Partially Signed Bitcoin Transaction) using the currently connected wallet provider. The function retrieves the provider from the wallet information stored in local storage and calls the corresponding signPSBT function from the PROVIDERS object to sign the PSBT with the specified parameters. If the signing process is successful, it returns the signed PSBT or transaction ID depending on the provider's implementation; otherwise, it throws an error indicating that signing the PSBT failed.
 *
 * @param psbtBase64 The PSBT to be signed, encoded in base64 format. This value will be sent to the provider to initiate the signing process.
 * @param broadcast A boolean indicating whether the signed transaction should be broadcasted to the network after signing. This value will be sent to the provider along with the PSBT to determine if the transaction should be broadcasted immediately after signing.
 * @param inputsToSign An array of inputs that need to be signed in the PSBT. This value will be sent to the provider to specify which inputs should be signed during the signing process.
 * @param message An optional message that can be included with the signing request. This can be used for additional context or information related to the signing operation.
 *
 * @returns A promise that resolves to the signed PSBT as a hexadecimal string if broadcast is false, or the transaction ID (txid) of the broadcasted transaction if broadcast is true. This allows developers to use the signed PSBT for further processing or to track the transaction on the blockchain. If there is an error in signing the PSBT or broadcasting it, the promise will be rejected with a descriptive error message.
 */
export async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message: string,
) {
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (walletInfo.provider === 'unisat') {
    await UNISAT.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'xverse') {
    await XVERSE.signPSBT(psbtBase64, broadcast, inputsToSign, message)
  }
  else if (walletInfo.provider === 'leather') {
    await LEATHER.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'me') {
    await ME.signPSBT(psbtBase64, broadcast, inputsToSign, message)
  }
  else if (walletInfo.provider === 'okx') {
    await OKX.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'local') {
    await LOCAL.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else {
    throw new Error('Provider not found')
  }
}
