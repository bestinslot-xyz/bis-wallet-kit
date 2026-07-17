import type { SwapFees } from '../lib/swap-reporting'
import type { UniswapInfoProxy } from '../lib/uniswap_ops'
import type { BISNetwork } from '../types/common'
import type { BISSwapWalletInfo } from './store'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import * as mod from '@noble/curves/abstract/modular.js'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as ethers from 'ethers'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { buildSwapFees } from '../lib/swap-reporting'
import {
  addLiquidityRequest,
  calculatePairAddress,
  removeLiquidityRequest,
  saveInfo,
  swap2Request,
  swapRequest,
  unwrapRequest,
  withdrawRequest,
} from '../lib/uniswap_ops'
import { InscriptionDetails } from '../types/inscription'
import { WalletInfo } from '../types/wallet'
import { compressSmartContractData } from './brc20'
import { clearExtraUtxos, saveExtraUtxos, utxoOutputTypeFromOutputScript } from './helpers'
import {
  mintAll,
  mintAllCheckFees,
  mintWithExtraInputInCommitAll,
  mintWithExtraInputInCommitFeeRate,
  sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll,
  sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate,
} from './mint'
import {
  getOrdinalsWallet,
  getPaymentWallet,
  getSignFn,
  signMessageLocalVerify,
  signMessageLocalVerifyDeterministic,
} from './providers'
import { getWalletInfo, readSwapWalletInfo, saveSwapWalletInfo } from './store'
import { getNetwork } from './store-network'

const SWAP_ABI_SIGNET = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'tokenAddress', type: 'address', internalType: 'address' },
      { name: 'tickerIdx', type: 'uint32', internalType: 'uint32' },
      { name: 'amt', type: 'uint256', internalType: 'uint256' },
      { name: 'pubkey', type: 'bytes', internalType: 'bytes' },
      { name: 'pkIdx', type: 'uint64', internalType: 'uint64' },
      { name: 'negSignatureBLS12', type: 'bytes', internalType: 'bytes' },
      { name: 'ecSignatureForIndexes', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
]
const SWAP_ABI_MAINNET = SWAP_ABI_SIGNET

const DUMMY_UTXO_VALUE = 1000
const GAS_PER_BYTE = 12000
const REFERRER_FEE_BPS = 2500n // 25% of the swap fee is paid out to the referrer.

const SIGNATURE_REQUEST_TEXT_SIGNET = `Sign this message only on official BiS interfaces.
This signature is required to generate your session-specific swap key.
Signing this message outside official BiS interfaces may result in unauthorized access to your swap session and is at the user's own risk.
By signing, you acknowledge that the BiS Terms of Service also apply: https://bestinslot.xyz/legal/terms.`
const SIGNATURE_REQUEST_TEXT_MAINNET = `Sign this message only on official BiS interfaces.
This signature is required to generate your session-specific swap key.
Signing this message outside official BiS interfaces may result in unauthorized access to your swap session and is at the user's own risk.
By signing, you acknowledge that the BiS Terms of Service also apply: https://bestinslot.xyz/legal/terms.

Current Network: Bitcoin Mainnet`

/**
 * A generic helper function to handle fetch requests with consistent error handling.
 * It automatically checks for non-ok HTTP responses and for an 'error' field
 * in the JSON response body, throwing a descriptive error in either case.
 *
 * @param url The URL to fetch.
 * @param options The standard RequestInit options for the fetch call.
 * @returns A promise that resolves with the parsed JSON data of type T.
 * @throws {Error} Throws an error if the network request fails, the HTTP
 * status is not ok, or the response body contains an error field.
 */
async function fetchWithErrors<T>(url: string, options: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, options)

    // Handle HTTP errors (e.g., 404, 500)
    if (!response.ok) {
      let errorDetails = `HTTP Error: ${response.status} ${response.statusText}`
      try {
        // Attempt to get a more specific error message from the response body
        const errorBody = await response.json()
        errorDetails = errorBody.error || JSON.stringify(errorBody)
      }
      catch {
        // Body is not JSON or is empty, fall back to the status text
      }
      throw new Error(errorDetails)
    }

    const data = await response.json()

    // Handle API-level errors returned in a 200 OK response
    if (data && data.error) {
      throw new Error(String(data.error))
    }

    return data as T
  }
  catch (error) {
    // Re-throw with a consistent prefix to identify the source of the error
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`API Request Failed: ${errorMessage}`)
  }
}

function getSignatureRequestText(): string {
  const network = getNetwork()
  if (network === 'signet') {
    return SIGNATURE_REQUEST_TEXT_SIGNET
  }
  else if (network === 'mainnet') {
    return SIGNATURE_REQUEST_TEXT_MAINNET
  }
  else {
    throw new Error('Unsupported network for swap signature request text')
  }
}

function getSwapBackendUrl(path: string): string {
  const network = getNetwork()
  if (network === 'signet') {
    return `https://sas-proxy.bestinslot.xyz/${path}`
  }
  else if (network === 'mainnet') {
    return `https://sa-proxy.bestinslot.xyz/${path}`
  }
  else {
    throw new Error('Unsupported network for orderbook backend URL')
  }
}

function getSwapContractAddress(): string {
  const network = getNetwork()
  if (network === 'signet') {
    return '0xf41B09041DC546F0466D6F74cda81971012B589D'
  }
  else if (network === 'mainnet') {
    return '0x62879BB3dD949c4CF06f71BF7c281DcF24D163e7'
  }
  else {
    throw new Error('Unsupported network for orderbook contract address')
  }
}

function getSwapContractInterface(): ethers.Interface {
  const network = getNetwork()
  if (network === 'signet') {
    return new ethers.Interface(SWAP_ABI_SIGNET)
  }
  else if (network === 'mainnet') {
    return new ethers.Interface(SWAP_ABI_MAINNET)
  }
  else {
    throw new Error('Unsupported network for orderbook contract address')
  }
}

/**
 * Checks IndexedDB for an existing swap wallet associated with the current ordinals wallet address.
 *
 * @returns {Promise<BISSwapWalletInfo | null>} Resolves with the SwapWalletInfo if found, or null if no wallet is stored for the current ordinals address.
 */
export async function getSwapWalletFromDB(): Promise<BISSwapWalletInfo | null> {
  const walletInfo = await readSwapWalletInfo(getOrdinalsWallet()?.address || '')
  return walletInfo
}

/**
 * Generates a new swap wallet by creating a BLS key pair derived from a deterministic signature of the user's ordinals wallet.
 *
 * The process involves:
 * 1. Validating that the ordinals wallet address is available.
 * 2. Generating a deterministic signature using the ordinals wallet's signing function, and deriving a BLS private key from it using HKDF.
 * 3. Computing the corresponding BLS public key.
 * 4. Storing the swap wallet information (Bitcoin address, BLS public key, and BLS private key) in IndexedDB for future use.
 *
 * @returns {Promise<BISSwapWalletInfo>} Resolves with the generated SwapWalletInfo containing the Bitcoin address, BLS public key, and BLS private key.
 */
export async function generateAndStoreSwapWallet(): Promise<BISSwapWalletInfo> {
  // 1. Validate Wallet
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userOrdinalsWallet?.address) {
    throw new Error('Ordinals wallet address not found.')
  }

  // 2. Generate BLS Privkey via BIP-322 signature
  const signatureHex = await signMessageLocalVerifyDeterministic(getSignatureRequestText())
  await new Promise(resolve => setTimeout(resolve, 500))
  const signatureHexTwin = await signMessageLocalVerifyDeterministic(getSignatureRequestText())
  if (signatureHex !== signatureHexTwin) {
    throw new Error('Deterministic signature mismatch. Please try again.')
  }
  // bls12 secret key is 32 bytes
  // get keccak256 of the signature to use as bls12 secret key
  const blsPrivKeyIKM = Buffer.from(ethers.keccak256(`0x${signatureHex}`).slice(2), 'hex')

  // Expand your input key material to 48 bytes.
  // For a 32-byte scalar, 48 bytes of hash gives ~2^-128 bias, per FIPS 186-5 / RFC 9380.
  const infoBuffer = Buffer.from('my-app/bls-keygen', 'utf-8')
  const okm = hkdf(sha256, blsPrivKeyIKM, undefined, infoBuffer, 48)

  // Map to scalar in [0, r-1], where r is BLS12-381 Fr order
  const skScalar = mod.mapHashToField(okm, bls12_381.fields.Fr.ORDER)
  const blsPrivKey = Buffer.from(skScalar)

  const blsPubKey = bls12_381.shortSignatures.getPublicKey(blsPrivKey)
  const blsPubKeyHex = `0x${blsPubKey.x.c0.toString(16).padStart(128, '0')}${blsPubKey.x.c1.toString(16).padStart(128, '0')}${blsPubKey.y.c0.toString(16).padStart(128, '0')}${blsPubKey.y.c1.toString(16).padStart(128, '0')}`
  const blsPrivKeyHex = `0x${blsPrivKey.toString('hex')}`

  // 3. Create Swap Wallet Info and store in DB
  const swapWalletInfo: BISSwapWalletInfo = {
    bitcoinAddress: userOrdinalsWallet.address,
    swapPubkey: blsPubKeyHex,
    swapPrivkey: blsPrivKeyHex,
  }

  // Store in IndexedDB
  await saveSwapWalletInfo(swapWalletInfo)
  return swapWalletInfo
}

export interface GetSwapStatusResponse {
  reorg_handler_running: boolean
  emergency_stop: boolean
}
/**
 * Checks the status of the swap backend, including whether the reorg handler is running and if emergency stop is active.
 *
 * This function is useful for the frontend to determine if the swap functionalities are currently operational or if there are any issues with the backend that users should be aware of.
 *
 * @returns {Promise<GetSwapStatusResponse>} An object containing the status of the reorg handler and emergency stop.
 */
export async function getSwapStatus(): Promise<GetSwapStatusResponse> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('status')

  // The helper handles the fetch and error checking.
  // We expect the API to return a string or number that can be converted to BigInt.
  const result = await fetchWithErrors<GetSwapStatusResponse>(url, {
    method: 'GET',
  })

  // 3. Convert the result to a BigInt
  return result
}

interface GetSwapAllowanceResponse {
  success: boolean
  result: string
}
/**
 * Checks the swap allowance for a given token address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the token to check the allowance for.
 *
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the swap allowance for the specified token address. The allowance is returned as a string from the API and converted to bigint in this function.
 */
export async function getSwapAllowance(tokenAddress: string): Promise<bigint> {
  // 1. Validate Wallet
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userOrdinalsWallet?.address) {
    throw new Error('Ordinals wallet address not found.')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('check_swap_allowance')
  const body = {
    ordinal_address: userOrdinalsWallet.address,
    token_address: tokenAddress,
  }

  // The helper handles the fetch and error checking.
  // We expect the API to return a string or number that can be converted to BigInt.
  const result = await fetchWithErrors<GetSwapAllowanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

export interface SwapInfo {
  factory_address: string // lowercased
  wbtc_address: string // lowercased
  wbtc_handler_address: string
}
interface SwapInfoResponse {
  success: boolean
  result: SwapInfo
}
// Keyed by network: each network has its own swap backend and therefore its own
// contract addresses, so one entry per network rather than a single slot.
const swapInfoCache = new Map<BISNetwork, SwapInfo>()
/**
 * Fetches the swap's deployment info — the factory, WBTC and WBTC handler addresses — for the current network, by making an API call to the swap backend. The result is fetched once per network and cached.
 *
 * This does not require a connected wallet or a smart wallet.
 *
 * @returns {Promise<SwapInfo>} A promise that resolves to a SwapInfo object containing the factory address, the WBTC token address, and the WBTC handler address.
 */
export async function getSwapInfo(): Promise<SwapInfo> {
  const network = getNetwork()
  const cached = swapInfoCache.get(network)
  if (cached) {
    return cached
  }

  // Prepare and execute the API call
  const url = getSwapBackendUrl('get_swap_info')

  // The helper handles the fetch and error checking.
  // We expect the API to return a string or number that can be converted to BigInt.
  const result = await fetchWithErrors<SwapInfoResponse>(url, {
    method: 'GET',
  })

  // Convert the result to SwapInfo
  const swapInfo = {
    factory_address: result.result.factory_address.toLowerCase(),
    wbtc_address: result.result.wbtc_address.toLowerCase(),
    wbtc_handler_address: result.result.wbtc_handler_address,
  }
  swapInfoCache.set(network, swapInfo)
  return swapInfo
}

/**
 * Throws a clear, upfront error when no swap pool with liquidity exists for the
 * given token pair (e.g. an unsupported token-to-token pair), so callers fail
 * fast instead of hitting a confusing error deeper in the swap math.
 *
 * @param token1Addr One side of the pair.
 * @param token2Addr The other side of the pair.
 */
async function assertPoolExists(token1Addr: string, token2Addr: string): Promise<void> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)
  const pairAddress = calculatePairAddress(token1Addr, token2Addr)
  let reserves: PairReserves
  try {
    reserves = await getPairReserves(pairAddress)
  }
  catch (error) {
    // A pair that was never created returns "Pair not found" from the backend
    // rather than zero reserves, so treat that as "no pool" too.
    if (error instanceof Error && /pair not found/i.test(error.message)) {
      throw new Error(`No swap pool with liquidity for ${token1Addr} / ${token2Addr}.`)
    }
    throw error
  }
  if (reserves.reserveA === 0n || reserves.reserveB === 0n) {
    throw new Error(`No swap pool with liquidity for ${token1Addr} / ${token2Addr}.`)
  }
}

interface GetBRC20ProgBalanceResponse {
  success: boolean
  result: string
}

/**
 * Checks the BRC-20 token balance for the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the BRC-20 token balance for the current ordinals wallet address. The balance is returned as a string from the API and converted to bigint in this function.
 */
export async function getBRC20ProgBalance(tokenAddress: string): Promise<bigint> {
  // 1. Validate Wallet
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userOrdinalsWallet?.address) {
    throw new Error('Ordinals wallet address not found.')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('check_brc20_balance')
  const body = {
    ordinal_address: userOrdinalsWallet.address,
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<GetBRC20ProgBalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

interface BaseBRC20Balance {
  available_balance_in_18_dec: bigint
  transferrable_balance_in_18_dec: bigint
  decimals: number
  ticker: string
}

interface GetBaseBRC20BalanceResponse {
  success: boolean
  result: BaseBRC20Balance
}

async function getBaseBRC20Balance(tokenAddress: string): Promise<BaseBRC20Balance> {
  // 1. Validate Wallet
  const userOrdinalsWallet = getOrdinalsWallet()
  if (!userOrdinalsWallet?.address) {
    throw new Error('Ordinals wallet address not found.')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('check_base_brc20_balance')
  const body = {
    ordinal_address: userOrdinalsWallet.address,
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<GetBaseBRC20BalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return {
    available_balance_in_18_dec: BigInt(result.result.available_balance_in_18_dec),
    transferrable_balance_in_18_dec: BigInt(result.result.transferrable_balance_in_18_dec),
    decimals: result.result.decimals,
    ticker: result.result.ticker,
  }
}

export interface SwapBalance {
  token_address: string
  balance: string
  ticker: string
  decimals: number
  is_lp: boolean
  price_sats: number
  reserve_token_amt?: string
  token_decimals?: number
  reserve_btc_amt?: string
  btc_decimals?: number
  lp_total_supply?: string
}

interface GetAllBalancesResponse {
  success: boolean
  result: SwapBalance[]
}

/**
 * Checks the swap balances for all tokens associated with the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param ordinalsAddress The ordinals wallet address to check the swap balances for.
 * @returns {Promise<SwapBalance[]>} A promise that resolves to an array of SwapBalance objects, each containing details about the token address, balance, ticker, decimals, whether it's an LP token, price in sats, and optionally reserve amounts and decimals for LP tokens. The balances are returned as strings from the API and can be converted to bigint if needed.
 */
export async function getSwapBalances(ordinalsAddress: string): Promise<SwapBalance[]> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_all_balances')
  const body = {
    ordinal_address: ordinalsAddress,
  }

  const result = await fetchWithErrors<GetAllBalancesResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result
  return result.result
}

interface GetSwapBalanceResponse {
  success: boolean
  result: string
}
/**
 * Checks the swap balance for a specific token address associated with the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the token to check the swap balance for.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the swap balance for the specified token address and current ordinals wallet address. The balance is returned as a string from the API and converted to bigint in this function.
 */
export async function getSwapBalance(tokenAddress: string): Promise<bigint> {
  // 1. Validate Wallet
  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const pubkey = swapWallet.swapPubkey

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_balance')
  const body = {
    pubkey,
    token_addr: tokenAddress,
  }

  const result = await fetchWithErrors<GetSwapBalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

async function getSwapBalanceOf(pubkey: string, tokenAddress: string): Promise<bigint> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_balance')
  const body = {
    pubkey,
    token_addr: tokenAddress,
  }

  const result = await fetchWithErrors<GetSwapBalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

export interface PairReserves {
  reserveA: bigint
  reserveB: bigint
  total_supply: bigint
}
interface GetPairReservesResponse {
  success: boolean
  result: PairReserves
}
/**
 * Checks the reserves of a specific token pair by making an API call to the swap backend.
 *
 * @param pairAddress The address of the token pair to check the reserves for.
 * @returns {Promise<PairReserves>} A promise that resolves to an object containing the reserves of token A, token B, and the total supply of liquidity tokens for the specified pair address. The reserves and total supply are returned as strings from the API and converted to bigint in this function.
 */
export async function getPairReserves(pairAddress: string): Promise<PairReserves> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_pair_reserves')
  const body = {
    pair_address: pairAddress,
  }

  const result = await fetchWithErrors<GetPairReservesResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return {
    reserveA: BigInt(result.result.reserveA),
    reserveB: BigInt(result.result.reserveB),
    total_supply: BigInt(result.result.total_supply),
  }
}

interface GetSwapWalletNonceResponse {
  success: boolean
  result: string
}
async function getSwapWalletNonce(): Promise<bigint> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_swap_wallet_nonce')
  const body = {
    pubkey,
  }

  const result = await fetchWithErrors<GetSwapWalletNonceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

interface GetSwapReferrerInfoResponse {
  success: boolean
  result: { pubkey: string, ref_return_bps: string }
}
async function getSwapReferrerInfo(
  currentPubkey: string,
  refId: string,
): Promise<{ referrerPubkey: string, refReturnBps: bigint }> {
  const url = getSwapBackendUrl('get_swap_referrer_info')
  const body = { ref_id: refId }

  const result = await fetchWithErrors<GetSwapReferrerInfoResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const sanitisedCurrentPubkey = currentPubkey.toLowerCase().startsWith('0x')
    ? currentPubkey.toLowerCase()
    : `0x${currentPubkey.toLowerCase()}`
  const sanitisedResultPubkey = result.result.pubkey.toLowerCase().startsWith('0x')
    ? result.result.pubkey.toLowerCase()
    : `0x${result.result.pubkey.toLowerCase()}`
  if (sanitisedResultPubkey === sanitisedCurrentPubkey) {
    throw new Error('Referrer ID cannot be the same as the current user')
  }

  return {
    referrerPubkey: result.result.pubkey,
    refReturnBps: BigInt(result.result.ref_return_bps),
  }
}

/**
 * Resolves a referral ID to the referrer's swap pubkey and their return-rate
 * (rebate) in basis points. Returns undefined fields if the referral cannot be
 * resolved, so a bad or expired referral degrades to a normal swap rather than
 * failing the order.
 *
 * @param currentPubkey The swap pubkey of the user performing the swap. Used to reject self-referrals.
 * @param refId The referral identifier to resolve.
 * @returns The referrer's swap pubkey and return-rate bps, or undefined fields when the referral is invalid.
 */
export async function tryGetSwapReferrerInfo(
  currentPubkey: string,
  refId: string,
): Promise<{ referrerPubkey: string | undefined, refReturnBps: bigint | undefined }> {
  try {
    return await getSwapReferrerInfo(currentPubkey, refId)
  }
  catch (error) {
    console.warn(`Failed to get referrer info for ref_id ${refId}:`, error)
    return { referrerPubkey: undefined, refReturnBps: undefined }
  }
}

interface RequestMinerFeeResponse {
  success: boolean
  result: string
}
/**
 * Requests the estimated miner fee for a specific swap operation type by making an API call to the swap backend.
 *
 * @param type The type of swap operation to estimate the miner fee for. Valid values are 'add_liquidity', 'remove_liquidity', 'swap', 'withdraw', or 'unwrap'.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the estimated miner fee for the specified swap operation type. The fee is returned as a string from the API and converted to bigint in this function.
 */
export async function requestMinerFee(
  type: 'add_liquidity' | 'remove_liquidity' | 'swap' | 'withdraw' | 'unwrap',
): Promise<bigint> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_miner_fee')
  const body = {
    type,
  }

  const result = await fetchWithErrors<RequestMinerFeeResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

export interface TokenInfo {
  token_address: string // compare case-insensitively; the backend does not normalise case
  symbol: string
  decimals: number
}
interface GetTokensResponse {
  tokens: TokenInfo[]
}
/**
 * Fetches every token tradable on the swap, ordered by symbol, by making an API call to the swap backend. LP tokens are excluded by the backend.
 *
 * This does not require a connected wallet or a smart wallet, so it can be used to populate a token picker before the user connects.
 *
 * @returns {Promise<TokenInfo[]>} A promise that resolves to an array of TokenInfo objects, each containing the token address, symbol, and decimals.
 */
export async function listTokens(): Promise<TokenInfo[]> {
  // 2. Prepare and execute the API call
  // No Content-Type: this GET has no body, and the header would force a CORS preflight.
  const url = getSwapBackendUrl('get_tokens')
  const result = await fetchWithErrors<GetTokensResponse>(url, {
    method: 'GET',
  })

  return result.tokens
}

export type ListPairsOrderBy
  = | 'price_asc'
    | 'price_desc'
    | 'price_change_24h_asc'
    | 'price_change_24h_desc'
    | 'price_change_7d_asc'
    | 'price_change_7d_desc'
    | 'volume_24h_asc'
    | 'volume_24h_desc'
    | 'volume_7d_asc'
    | 'volume_7d_desc'
    | 'tvl_asc'
    | 'tvl_desc'
    | 'apr_asc'
    | 'apr_desc'
export interface ListPairsRequest {
  order_by?: ListPairsOrderBy
  page?: number
  count?: number // max 100
}
export interface PairInfo {
  pair_address: string
  pair_name: string
  token_a_addr: string // compare case-insensitively; the backend does not normalise case
  token_a_symbol: string
  token_b_addr: string // compare case-insensitively; the backend does not normalise case
  token_b_symbol: string
  price: number
  price_change_24h: number
  price_change_7d: number
  volume_24h: bigint
  volume_7d: bigint
  lp_fee_tier: number
  tvl: bigint
  apr: number
}
export interface ListPairsResponse {
  page: number
  count: number
  total: number
  data: PairInfo[]
}
interface GetTableDataResponse {
  page: number
  count: number
  total: number
  data: (Omit<PairInfo, 'volume_24h' | 'volume_7d' | 'tvl'> & {
    volume_24h: string
    volume_7d: string
    tvl: string
  })[]
}
/**
 * Fetches a paginated, sortable listing of every swap pair and its market data by making an API call to the swap backend.
 *
 * This does not require a connected wallet or a smart wallet, so it can be used to populate a market table or pair selector before the user connects.
 *
 * @param params (Optional) An object containing the sort order (defaults to 'tvl_desc'), the page to fetch (defaults to 1), and the number of pairs per page (defaults to 20, max 100).
 * @returns {Promise<ListPairsResponse>} A promise that resolves to an object containing the current page, page size, total number of pairs, and an array of PairInfo objects. Each pair includes both token addresses and symbols, price, 24h/7d price change, 24h/7d volume, LP fee tier, TVL, and APR. The volumes and TVL are returned as strings from the API and converted to bigint in this function.
 */
export async function listPairs(params: ListPairsRequest = {}): Promise<ListPairsResponse> {
  const orderBy = params.order_by ?? 'tvl_desc'
  const page = params.page ?? 1
  const count = params.count ?? 20

  if (count > 100) {
    throw new Error('Count cannot exceed 100')
  }

  // 2. Prepare and execute the API call
  // Encoded rather than interpolated: the kit ships to untyped JS callers, so
  // the param types are not enforced at runtime.
  // No Content-Type: this GET has no body, and the header would force a CORS preflight.
  const query = new URLSearchParams({
    order_by: orderBy,
    page: String(page),
    count: String(count),
  })
  const url = getSwapBackendUrl(`get_table_data?${query}`)
  const result = await fetchWithErrors<GetTableDataResponse>(url, {
    method: 'GET',
  })

  // 3. Convert the result to a BigInt
  return {
    page: result.page,
    count: result.count,
    total: result.total,
    data: result.data.map(pair => ({
      ...pair,
      volume_24h: BigInt(pair.volume_24h),
      volume_7d: BigInt(pair.volume_7d),
      tvl: BigInt(pair.tvl),
    })),
  }
}

export interface GetPairVolumeRequest {
  pair_address: string
  days: number
}
export interface GetPairVolumeResponse {
  pair_address: string
  token_a_address: string
  token_a_symbol: string
  token_b_address: string
  token_b_symbol: string
  period_days: number
  total_volume_wbtc: string
  total_trades: number
  start_time: string
  end_time: string
}
/**
 * Fetches the trading volume and number of trades for a specific token pair over a given number of days by making an API call to the swap backend.
 *
 * @param params An object containing the pair address and the number of days to look back for volume data.
 * @returns {Promise<GetPairVolumeResponse>} A promise that resolves to an object containing the pair address, token addresses and symbols, period in days, total volume in WBTC, total number of trades, and the start and end time of the period. The total volume is returned as a string from the API and can be converted to bigint if needed.
 */
export async function getPairVolumeOverDays(
  params: GetPairVolumeRequest,
): Promise<GetPairVolumeResponse> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl(`volume/${params.pair_address}?days=${params.days}`)
  const result = await fetchWithErrors<GetPairVolumeResponse>(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  return result
}

export interface GetKlinesRequest {
  pair_address: string
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  limit: number // max 1000
  startTime: number | null
  endTime: number | null
}
export interface Kline {
  open_time: number
  close_time: number
  open: number
  high: number
  low: number
  close: number
  volume_wbtc: string
  trades: number
}
export interface GetKlinesResponse {
  pair_address: string
  token_a_address: string
  token_a_symbol: string
  token_b_address: string
  token_b_symbol: string
  interval: string
  klines: Kline[]
}
/**
 * Fetches the historical price and volume data (klines) for a specific token pair and time interval by making an API call to the swap backend.
 *
 * @param params An object containing the pair address, desired time interval for the klines, limit on the number of klines to fetch (max 1000), and optional start and end timestamps to filter the klines.
 * @returns {Promise<GetKlinesResponse>} A promise that resolves to an object containing the pair address, token addresses and symbols, interval, and an array of kline data. Each kline includes open time, close time, open price, high price, low price, close price, volume in WBTC, and number of trades. The volume is returned as a string from the API and can be converted to bigint if needed.
 */
export async function getKlines(params: GetKlinesRequest): Promise<GetKlinesResponse> {
  if (params.limit > 1000) {
    throw new Error('Limit cannot exceed 1000')
  }

  // 2. Prepare and execute the API call
  let url = getSwapBackendUrl(
    `klines/${params.pair_address}?interval=${params.interval}&limit=${params.limit}`,
  )
  if (params.startTime !== null) {
    url += `&startTime=${params.startTime}`
  }
  if (params.endTime !== null) {
    url += `&endTime=${params.endTime}`
  }

  const result = await fetchWithErrors<GetKlinesResponse>(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  return result
}

export interface GetActivityOfPairRequest {
  pair_address: string
  limit: number // max 200
  offset: number
}
export interface PairActivityEntry {
  id: string
  type: 'add_liq' | 'remove_liq' | 'swap1' | 'swap2'
  timestamp: number
  block_height: number
  success: boolean // did the transaction succeed
  user_address: string // btc address of the user
  user_pubkey: string // bls pubkey of the user
  amount1: string // amount of token1
  amount2: string // amount of token2
  liquidity: string | null // liquidity tokens (for add/remove liquidity)
  token_1: string // token1 address
  token_2: string // token2 address
}
export interface GetActivityOfPairResponse {
  pair_address: string
  token_a: {
    address: string
    symbol: string
    decimals: number
  }
  token_b: {
    address: string
    symbol: string
    decimals: number
  }
  activities: PairActivityEntry[]
}
/**
 * Fetches the recent swap activities for a specific token pair by making an API call to the swap backend.
 *
 * @param params An object containing the pair address, limit on the number of activities to fetch (max 200), and offset for pagination.
 * @returns {Promise<GetActivityOfPairResponse>} A promise that resolves to an object containing the pair address, token details, and an array of recent activities for that pair. Each activity includes details such as the type of activity (add/remove liquidity or swap), timestamp, block height, success status, user address and pubkey, amounts involved, and token addresses.
 */
export async function getActivityOfPair(
  params: GetActivityOfPairRequest,
): Promise<GetActivityOfPairResponse> {
  if (params.limit > 200) {
    throw new Error('Limit cannot exceed 200')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl(
    `pair-activity/${params.pair_address}?limit=${params.limit}&offset=${params.offset}`,
  )
  const result = await fetchWithErrors<GetActivityOfPairResponse>(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  return result
}

interface GetWalletActivitiesRequest {
  pubkey: string
  pairAddress: string
}

export interface WalletActivityEntry {
  id: string
  type:
    | 'add_liq'
    | 'remove_liq'
    | 'swap1'
    | 'swap2'
    | 'deposit'
    | 'unwrap'
    | 'withdraw'
    | 'withdraw (lp)'
  timestamp: number | null
  block_height: number | null
  success: boolean // did the transaction succeed

  token_1: {
    address: string
    symbol: string
    decimals: number
  }
  token_2?: {
    address: string
    symbol: string
    decimals: number
  }
  amount1: string // amount of token1
  amount2?: string // amount of token2

  txid: string | null // txid of the transaction for deposits
  liquidity?: string | null // liquidity tokens (for add/remove liquidity)

  target_address?: string | null // evm address of the target for withdrawals
  target_pkscript?: string | null // pkscript of the target for unwraps
}

export interface GetWalletActivitiesResponse {
  pubkey: string
  btc_address: string
  pair_address: string
  activities: WalletActivityEntry[]
}
/**
 * Fetches the swap activities associated with a specific wallet public key and pair address by making an API call to the swap backend.
 *
 * @param params An object containing the wallet public key and pair address to query activities for.
 * @returns {Promise<GetWalletActivitiesResponse>} A promise that resolves to an object containing the wallet public key, associated Bitcoin address, pair address, and a list of swap activities (deposits, swaps, liquidity changes, withdrawals) related to that wallet and pair.
 */
export async function getWalletActivities(
  params: GetWalletActivitiesRequest,
): Promise<GetWalletActivitiesResponse> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl(
    `wallet-activity/${params.pubkey}?pairAddress=${params.pairAddress}`,
  )
  const result = await fetchWithErrors<GetWalletActivitiesResponse>(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  return result
}

/**
 * Fetches the number of decimals for a given token address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the token to fetch the decimals for.
 * @returns {Promise<number>} A promise that resolves to a number representing the decimals for the specified token address.
 */
export async function getTokenDecimals(tokenAddress: string): Promise<number> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_token_decimals')
  const body = {
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<{ success: boolean, result: number }>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return result.result
}

interface DepositBIP322SignatureRequest {
  btc_address: string
  bls_pubkey: string
  token_address: string
}
async function getDepositBIP322Signature(toSend: DepositBIP322SignatureRequest): Promise<string> {
  toSend.bls_pubkey = toSend.bls_pubkey.startsWith('0x')
    ? toSend.bls_pubkey.slice(2)
    : toSend.bls_pubkey
  toSend.bls_pubkey = toSend.bls_pubkey.toLowerCase()
  toSend.token_address = toSend.token_address.toLowerCase()

  const signatureText = `Deposit Order:
Bitcoin Address: ${toSend.btc_address}
BLS Public Key: ${toSend.bls_pubkey}
Token Address: ${toSend.token_address}

By signing this message, you authorize the creation of a deposit order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface DepositBLSSignatureRequest {
  pubkey: string
  pk_idx: bigint
}
async function getDepositBLSSignature(params: DepositBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = params.pk_idx.toString(16).padStart(16, '0')
  msg += params.pubkey

  const messageBuffer = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(messageBuffer, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivKeyBuffer = Buffer.from(blsPrivKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivKeyBuffer)
  const negatedSig = blsSignature.negate()

  return `0x${negatedSig.x.toString(16).padStart(128, '0')}${negatedSig.y.toString(16).padStart(128, '0')}`
}
interface EmergencyBLSSignatureRequest {
  pubkey: string
  ordinals_script: string
}
async function getEmergencyBLSSignature(params: EmergencyBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += '99' // emergency withdraw code
  msg += params.ordinals_script

  const messageBuffer = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(messageBuffer, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivKeyBuffer = Buffer.from(blsPrivKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivKeyBuffer)
  const negatedSig = blsSignature.negate()

  return `0x${negatedSig.x.toString(16).padStart(128, '0')}${negatedSig.y.toString(16).padStart(128, '0')}`
}

interface DepositSignatureRequest {
  btc_address: string
  bls_pubkey: string
  token_address: string
  bip322_signature: string
  bls12_signature: string
}
interface DepositSignatureResponse {
  success: boolean
  edcsa_signature: string
  pubkey_idx: number
  token_idx: number
}
async function getDepositSignature(
  toSend: DepositSignatureRequest,
): Promise<DepositSignatureResponse> {
  const url = getSwapBackendUrl('get_deposit_signature')

  return fetchWithErrors<DepositSignatureResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

interface ApproveDetails {
  commit_txid: string
  commit_txhex: string
  reveal_txid: string
  reveal_txhex: string
  send_to_opreturn_txid: string
  send_to_opreturn_txhex: string
  secret: string
  inscription_id: string
  fee_rate: number
}
interface BroadcastDepositOrderRequest {
  commit_txid: string
  commit_txhex: string
  reveal_txid: string
  reveal_txhex: string
  send_to_opreturn_txid: string
  send_to_opreturn_txhex: string
  secret: string
  inscription_id: string
  fee_rate: number
  approve_details: ApproveDetails | null
  base_deposit_details: ApproveDetails | null
}
interface BroadcastDepositOrderResponse {
  success: boolean
  result: string[] // txid array
}
async function broadcastDepositOrder(
  toSend: BroadcastDepositOrderRequest,
): Promise<BroadcastDepositOrderResponse> {
  const url = getSwapBackendUrl('deposit')

  return fetchWithErrors<BroadcastDepositOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

function convertAmountToBRC20String(amountInDec18: bigint, decimals: number): string {
  if (amountInDec18 < 0n) {
    throw new Error('Amount cannot be negative')
  }
  if (decimals < 0 || decimals > 18) {
    throw new Error('Decimals must be between 0 and 18')
  }
  const amountDecimals = 18

  const amountStr = amountInDec18.toString().padStart(amountDecimals + 1, '0')
  const integerPart = amountStr.slice(0, -amountDecimals)
  let fractionalPart = amountStr.slice(-amountDecimals).replace(/0+$/, '') // remove trailing zeros
  if (fractionalPart.length > decimals) {
    if (decimals === 0) {
      // ceil integer part
      return (BigInt(integerPart) + 1n).toString()
    }
    else {
      fractionalPart = fractionalPart.slice(0, decimals) // trim to token decimals and ceil
      fractionalPart = (BigInt(fractionalPart) + 1n).toString().padStart(decimals, '0')
      if (fractionalPart.length > decimals) {
        // Rounding caused overflow to integer part
        return (BigInt(integerPart) + 1n).toString()
      }
      fractionalPart = fractionalPart.replace(/0+$/, '') // remove trailing zeros again
    }
  }
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart
}

/**
 * Creates and broadcasts a deposit order for swapping BRC-20 tokens by performing necessary checks, generating signatures, and making API calls to the swap backend. The function handles both BRC-2.0 and base BRC-20 token balances, checks allowances, and prepares the required data for the deposit order.
 *
 * @param tokenAddress The address of the BRC-20 token to deposit.
 * @param tokenAmount The amount of the BRC-20 token to deposit, represented as a bigint in 18 decimals format.
 * @param feeRate The fee rate to use for the transactions, represented in sats/vbyte.
 * @param createAllowanceIfNeeded A boolean flag indicating whether to create an allowance for the BRC-2.0 token transfer if the current allowance is insufficient. Defaults to true.
 *
 * @returns {Promise<string[]>} A promise that resolves to an array of transaction IDs (txids) for the transactions involved in the deposit order, including the commit transaction, reveal transaction, and send-to-opreturn transaction.
 */
export async function createAndBroadcastDepositOrder(
  tokenAddress: string,
  tokenAmount: bigint,
  feeRate: number,
  createAllowanceIfNeeded: boolean = true,
): Promise<string[]> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Sign function
  const signFn = getSignFn(walletInfo.provider)
  const network = getBitcoinNetwork()
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()

  if (!userPaymentWallet)
    throw new Error('Payment wallet not found')
  if (!userPaymentWallet.address)
    throw new Error('Payment wallet address not found')

  if (!userOrdinalsWallet)
    throw new Error('Ordinals wallet not found')
  if (!userOrdinalsWallet.address)
    throw new Error('Ordinals wallet address not found')

  const payerAddress = userPaymentWallet.address
  const payerPubKey = userPaymentWallet.pubkey
  const ordinalsAddress = userOrdinalsWallet.address

  const payerWallet = new WalletInfo(false, null, payerAddress, null, payerPubKey)

  let useBaseAvailableBalanceAmount = 0n
  let baseTokenDecimals = 0
  let baseTokenTicker = ''
  const currentTokenAmount = await getBRC20ProgBalance(tokenAddress)
  if (currentTokenAmount < tokenAmount) {
    const currentBaseAvailableTokenInfo = await getBaseBRC20Balance(tokenAddress)
    const currentBaseAvailableTokenAmount
      = currentBaseAvailableTokenInfo.available_balance_in_18_dec
    baseTokenDecimals = currentBaseAvailableTokenInfo.decimals
    baseTokenTicker = currentBaseAvailableTokenInfo.ticker
    useBaseAvailableBalanceAmount = tokenAmount - currentTokenAmount
    if (currentBaseAvailableTokenAmount < useBaseAvailableBalanceAmount) {
      console.error(
        `Insufficient BRC-2.0 + BRC20 available balance. Current BRC-2.0: ${currentTokenAmount}, Available in base: ${currentBaseAvailableTokenAmount}, Required: ${tokenAmount}`,
      )
      throw new Error('Insufficient BRC-2.0 + BRC20 available balance')
    }
  }

  const currentAllowance = await getSwapAllowance(tokenAddress)
  let needsAllowance = false
  if (
    currentAllowance < BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  ) {
    if (!createAllowanceIfNeeded) {
      console.error('Insufficient allowance for BRC-2.0 token transfer.')
      throw new Error('Insufficient allowance for BRC-2.0 token transfer.')
    }
    needsAllowance = true
  }

  const l1ContractAddress = getSwapContractAddress()
  const allowanceCalldata = `0x095ea7b3000000000000000000000000${l1ContractAddress.slice(2).toLowerCase()}ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`
  const allowanceCalldataCompressed = await compressSmartContractData(allowanceCalldata)
  const allowanceContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${tokenAddress}","b":"${allowanceCalldataCompressed}"}`,
  )
  const allowanceInscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    allowanceContent,
  )

  const swapPubKey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swapPubKey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const bip322Signature = await getDepositBIP322Signature({
    btc_address: ordinalsAddress,
    bls_pubkey: swapPubKey,
    token_address: tokenAddress,
  })

  const ordinalsScript = bitcoinjs.address.toOutputScript(ordinalsAddress, getBitcoinNetwork())
  const negSignatureBLS12Emergency = await getEmergencyBLSSignature({
    pubkey: swapPubKey,
    ordinals_script: ordinalsScript.toString('hex'),
  })
  const depositDetails = await getDepositSignature({
    btc_address: ordinalsAddress,
    bls_pubkey: swapPubKey,
    token_address: tokenAddress.toLowerCase(),
    bip322_signature: bip322Signature,
    bls12_signature: negSignatureBLS12Emergency,
  })
  const ecdsaSignature = depositDetails.edcsa_signature
  const pubkeyIdx = depositDetails.pubkey_idx
  const tokenIdx = depositDetails.token_idx

  const negSignatureBLS12 = await getDepositBLSSignature({
    pubkey: swapPubKey,
    pk_idx: BigInt(pubkeyIdx),
  })

  const l1Swap = getSwapContractInterface()
  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecdsaSignature
  const depositCalldata = l1Swap.encodeFunctionData('deposit', [
    tokenAddress,
    tokenIdx,
    tokenAmount,
    swapPubKey,
    BigInt(pubkeyIdx),
    negSignatureBLS12,
    ecdsaSignature,
  ])
  const depositCalldataCompressed = await compressSmartContractData(depositCalldata)
  const depositContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${l1ContractAddress}","b":"${depositCalldataCompressed}"}`,
  )
  const depositInscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    depositContent,
  )

  let baseDepositInscriptionId: string | null = null
  let baseDepositSecret: string | null = null
  let baseDepositCommitTxId: string | null = null
  let baseDepositRevealTxId: string | null = null
  let baseDepositCommitTxHex: string | null = null
  let baseDepositRevealTxHex: string | null = null
  let baseDepositSendToOpReturnTxHex: string | null = null
  let baseDepositSendToOpReturnTxId: string | null = null
  let baseDepositMintRes = null
  if (useBaseAvailableBalanceAmount > 0n) {
    const amountToDeposit = convertAmountToBRC20String(
      useBaseAvailableBalanceAmount,
      baseTokenDecimals,
    )
    const baseDepositInscriptionDetails = new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      Buff.str(
        `{"p":"brc-20","op":"transfer","tick":"${baseTokenTicker}","amt":"${amountToDeposit}"}`,
      ),
    )

    baseDepositMintRes = await mintAll(
      baseDepositInscriptionDetails,
      feeRate,
      null,
      null,
      0,
      true,
      signFn,
    )
    baseDepositCommitTxHex = baseDepositMintRes.signed_commit_tx_hex
    baseDepositRevealTxHex = baseDepositMintRes.signed_reveal_tx_hex
    baseDepositCommitTxId = baseDepositMintRes.commit_txid
    baseDepositRevealTxId = baseDepositMintRes.reveal_txid
    baseDepositInscriptionId = baseDepositMintRes.inscription_id
    const satpoint = `${baseDepositInscriptionId.split('i')[0]}:0:0`
    baseDepositSecret = baseDepositMintRes.secret
    let sendToOpreturnRes = null
    try {
      if (!baseDepositCommitTxHex) {
        throw new Error('Base deposit commit tx hex is missing')
      }
      saveExtraUtxos(
        [baseDepositCommitTxHex, baseDepositRevealTxHex],
        [baseDepositInscriptionId, satpoint],
      )

      const targetWallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extraOutputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
        baseDepositInscriptionId,
        [],
        targetWallet,
        1,
        extraOutputs,
        feeRate,
        true,
        signFn,
      )
    }
    finally {
      clearExtraUtxos()
    }

    if (sendToOpreturnRes == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    baseDepositSendToOpReturnTxHex = sendToOpreturnRes.signedTxHex
    baseDepositSendToOpReturnTxId = sendToOpreturnRes.txId
  }

  let allowanceInscriptionId: string | null = null
  let allowanceSecret: string | null = null
  let allowanceCommitTxid: string | null = null
  let allowanceRevealTxid: string | null = null
  let allowanceCommitTxHex: string | null = null
  let allowanceRevealTxHex: string | null = null
  let allowanceSendToOpReturnTxHex: string | null = null
  let allowanceSendToOpReturnTxid: string | null = null
  let allowanceMintRes = null
  if (needsAllowance) {
    const extraTxhexesForAllowance = []
    if (useBaseAvailableBalanceAmount > 0n) {
      extraTxhexesForAllowance.push(
        baseDepositCommitTxHex!,
        baseDepositRevealTxHex!,
        baseDepositSendToOpReturnTxHex!,
      )
    }
    try {
      saveExtraUtxos(extraTxhexesForAllowance, null)
      allowanceMintRes = await mintAll(
        allowanceInscriptionDetails,
        feeRate,
        null,
        null,
        0,
        true,
        signFn,
      )
      allowanceCommitTxHex = allowanceMintRes.signed_commit_tx_hex
      allowanceRevealTxHex = allowanceMintRes.signed_reveal_tx_hex
      allowanceCommitTxid = allowanceMintRes.commit_txid
      allowanceRevealTxid = allowanceMintRes.reveal_txid
      allowanceInscriptionId = allowanceMintRes.inscription_id
      allowanceSecret = allowanceMintRes.secret
    }
    finally {
      clearExtraUtxos()
    }

    const satpoint = `${allowanceInscriptionId.split('i')[0]}:0:0`
    let sendToOpreturnRes = null
    try {
      if (!allowanceCommitTxHex) {
        throw new Error('Allowance commit tx hex is missing')
      }
      extraTxhexesForAllowance.push(allowanceCommitTxHex, allowanceRevealTxHex)
      saveExtraUtxos(extraTxhexesForAllowance, [allowanceInscriptionId, satpoint])

      const targetWallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extraOutputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
        allowanceInscriptionId,
        [],
        targetWallet,
        1,
        extraOutputs,
        feeRate,
        true,
        signFn,
      )
    }
    finally {
      clearExtraUtxos()
    }

    if (sendToOpreturnRes == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    allowanceSendToOpReturnTxHex = sendToOpreturnRes.signedTxHex
    allowanceSendToOpReturnTxid = sendToOpreturnRes.txId
  }

  const extraUtxos = []
  const extraTxHexes = []
  if (useBaseAvailableBalanceAmount > 0n) {
    if (!baseDepositCommitTxHex || !baseDepositRevealTxHex || !baseDepositSendToOpReturnTxHex) {
      throw new Error('Base deposit transaction hexes are missing')
    }
    extraTxHexes.push(
      baseDepositCommitTxHex,
      baseDepositRevealTxHex,
      baseDepositSendToOpReturnTxHex,
    )

    extraUtxos.push({
      utxo: `${baseDepositSendToOpReturnTxId}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }
  if (needsAllowance) {
    if (!allowanceCommitTxHex || !allowanceRevealTxHex || !allowanceSendToOpReturnTxHex) {
      throw new Error('Allowance transaction hexes are missing')
    }
    extraTxHexes.push(allowanceCommitTxHex, allowanceRevealTxHex, allowanceSendToOpReturnTxHex)

    extraUtxos.push({
      utxo: `${allowanceSendToOpReturnTxid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }

  let sendToOpreturnRes = null
  let depositMintRes = null
  let depositInscriptionId: string = ''
  let depositSecret: string = ''
  let depositCommitTxHex: string = ''
  let depositRevealTxHex: string = ''
  try {
    if (extraTxHexes.length > 0) {
      saveExtraUtxos(extraTxHexes, null)
    }
    depositMintRes = await mintWithExtraInputInCommitAll(
      depositInscriptionDetails,
      extraUtxos,
      feeRate,
      null,
      null,
      0,
      true,
      signFn,
    )
    depositCommitTxHex = depositMintRes.signedCommitTxHex
    depositRevealTxHex = depositMintRes.signedRevealTxHex
    depositInscriptionId = depositMintRes.inscriptionId
    const depositSatpoint = `${depositInscriptionId.split('i')[0]}:0:0`
    depositSecret = depositMintRes.secret
    extraTxHexes.push(depositCommitTxHex!, depositRevealTxHex!)
    saveExtraUtxos(extraTxHexes, [depositInscriptionId, depositSatpoint])
    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
      depositInscriptionId,
      [],
      targetWallet,
      1,
      [],
      feeRate,
      true,
      signFn,
    )
  }
  finally {
    clearExtraUtxos()
  }

  if (sendToOpreturnRes == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  const depositSendToOpReturnTxHex = sendToOpreturnRes.signedTxHex
  const depositSendToOpReturnTxid = sendToOpreturnRes.txId

  const toSendForBroadcast: BroadcastDepositOrderRequest = {
    commit_txid: depositMintRes.commitTxId,
    commit_txhex: depositCommitTxHex,
    reveal_txid: depositMintRes.revealTxId,
    reveal_txhex: depositRevealTxHex,
    send_to_opreturn_txid: depositSendToOpReturnTxid,
    send_to_opreturn_txhex: depositSendToOpReturnTxHex,
    secret: depositSecret,
    inscription_id: depositInscriptionId,
    fee_rate: feeRate,

    approve_details: needsAllowance
      ? {
          commit_txid: allowanceCommitTxid!,
          commit_txhex: allowanceCommitTxHex!,
          reveal_txid: allowanceRevealTxid!,
          reveal_txhex: allowanceRevealTxHex!,
          send_to_opreturn_txid: allowanceSendToOpReturnTxid!,
          send_to_opreturn_txhex: allowanceSendToOpReturnTxHex!,
          secret: allowanceSecret!,
          inscription_id: allowanceInscriptionId!,
          fee_rate: feeRate,
        }
      : null,

    base_deposit_details:
      useBaseAvailableBalanceAmount > 0n
        ? {
            commit_txid: baseDepositCommitTxId!,
            commit_txhex: baseDepositCommitTxHex!,
            reveal_txid: baseDepositRevealTxId!,
            reveal_txhex: baseDepositRevealTxHex!,
            send_to_opreturn_txid: baseDepositSendToOpReturnTxId!,
            send_to_opreturn_txhex: baseDepositSendToOpReturnTxHex!,
            secret: baseDepositSecret!,
            inscription_id: baseDepositInscriptionId!,
            fee_rate: feeRate,
          }
        : null,
  }
  const broadcastRes = await broadcastDepositOrder(toSendForBroadcast)

  return broadcastRes.result
}

/**
 * Checks the miner fees required for creating a deposit order for swapping BRC-20 tokens, including the fees for minting inscriptions for allowance and deposit, as well as the fees for sending those inscriptions to OP_RETURN. The function also checks if the user has sufficient balance and allowance for the specified token amount.
 *
 * @param tokenAddress The address of the BRC-20 token to deposit.
 * @param tokenAmount The amount of the BRC-20 token to deposit, represented as a bigint in 18 decimals format.
 * @param feeRate The fee rate to use for the transactions, represented in sats/vbyte.
 * @param createAllowanceIfNeeded A boolean flag indicating whether to include the fees for creating an allowance inscription if the current allowance is insufficient. Defaults to true.
 *
 * @returns A promise that resolves to an object containing the following properties:
 * - needs_approval: A boolean indicating whether an allowance inscription needs to be created.
 * - allowance_fees_total: The total miner fees for creating and sending the allowance inscription to OP_RETURN (0 if no allowance inscription is needed).
 * - base_deposit_fees_total: The total miner fees for creating and sending the base deposit inscription to OP_RETURN (0 if no base deposit inscription is needed).
 * - deposit_fees_total: The total miner fees for creating and sending the deposit inscription to OP_RETURN.
 * - fee_rate: The fee rate used for the calculations, in sats/vbyte.
 */
export async function getMinerFeesOfDepositOrder(
  tokenAddress: string,
  tokenAmount: bigint,
  feeRate: number,
  createAllowanceIfNeeded: boolean = true,
): Promise<{
  needs_approval: boolean
  allowance_fees_total: number
  base_deposit_fees_total: number
  deposit_fees_total: number
  fee_rate: number
}> {
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Sign function
  const network = getBitcoinNetwork()
  const userPaymentWallet = getPaymentWallet()

  if (!userPaymentWallet)
    throw new Error('Payment wallet not found')
  if (!userPaymentWallet.address)
    throw new Error('Payment wallet address not found')

  const payerAddr = userPaymentWallet.address
  const payerPublicKey = userPaymentWallet.pubkey

  const payerWallet = new WalletInfo(false, null, payerAddr, null, payerPublicKey)

  let useBaseAvailableBalanceAmt = 0n
  let baseTokenDecimals = 0
  let baseTokenTicker = ''
  const currentTokenAmount = await getBRC20ProgBalance(tokenAddress)
  if (currentTokenAmount < tokenAmount) {
    const currentBaseAvailableTokenInfo = await getBaseBRC20Balance(tokenAddress)
    const currentBaseAvailableTokenAmount
      = currentBaseAvailableTokenInfo.available_balance_in_18_dec
    baseTokenDecimals = currentBaseAvailableTokenInfo.decimals
    baseTokenTicker = currentBaseAvailableTokenInfo.ticker
    useBaseAvailableBalanceAmt = tokenAmount - currentTokenAmount
    if (currentBaseAvailableTokenAmount < useBaseAvailableBalanceAmt) {
      console.error(
        `Insufficient BRC-2.0 + BRC20 available balance. Current BRC-2.0: ${currentTokenAmount}, Available in base: ${currentBaseAvailableTokenAmount}, Required: ${tokenAmount}`,
      )
      throw new Error('Insufficient BRC-2.0 + BRC20 available balance')
    }
  }

  const currentAllowance = await getSwapAllowance(tokenAddress)
  let needsAllowance = false
  if (
    currentAllowance < BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  ) {
    if (!createAllowanceIfNeeded) {
      console.error('Insufficient allowance for BRC-2.0 token transfer.')
      throw new Error('Insufficient allowance for BRC-2.0 token transfer.')
    }
    needsAllowance = true
  }

  const l1ContractAddress = getSwapContractAddress()
  const allowanceCalldata = `0x095ea7b3000000000000000000000000${l1ContractAddress.slice(2).toLowerCase()}ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`
  const allowanceCalldataCompressed = await compressSmartContractData(allowanceCalldata)
  const allowanceContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${tokenAddress}","b":"${allowanceCalldataCompressed}"}`,
  )
  const allowanceInscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    allowanceContent,
  )

  const swapPubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swapPubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ecSignature = `0x${'00'.repeat(64)}` // dummy
  const pubkeyIdx = 1 // dummy
  const tokenIdx = 1 // dummy

  const negSignatureBls12 = await getDepositBLSSignature({
    pubkey: swapPubkey,
    pk_idx: BigInt(pubkeyIdx),
  })

  const l1Swap = getSwapContractInterface()
  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const depositCalldata = l1Swap.encodeFunctionData('deposit', [
    tokenAddress,
    tokenIdx,
    tokenAmount,
    swapPubkey,
    BigInt(pubkeyIdx),
    negSignatureBls12,
    ecSignature,
  ])
  const depositCalldataCompressed = await compressSmartContractData(depositCalldata)
  const depositContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${l1ContractAddress}","b":"${depositCalldataCompressed}"}`,
  )
  const depositInscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    depositContent,
  )

  let baseDepositInscriptionId = null
  let baseDepositCommitTxHex = null
  let baseDepositRevealTxHex = null
  let baseDepositSendToOpReturnTxHex = null
  let baseDepositSendToOpReturnTxid = null
  let baseDepositFeesTotal = 0
  if (useBaseAvailableBalanceAmt > 0n) {
    const amountToDeposit = convertAmountToBRC20String(
      useBaseAvailableBalanceAmt,
      baseTokenDecimals,
    )
    const baseDepositInscriptionDetails = new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      Buff.str(
        `{"p":"brc-20","op":"transfer","tick":"${baseTokenTicker}","amt":"${amountToDeposit}"}`,
      ),
    )

    const baseDepositMintRes = await mintAllCheckFees(
      baseDepositInscriptionDetails,
      feeRate,
      null,
      null,
      0,
    )
    baseDepositCommitTxHex = baseDepositMintRes.unsigned_commit_tx_hex
    baseDepositRevealTxHex = baseDepositMintRes.signed_reveal_tx_hex
    baseDepositInscriptionId = baseDepositMintRes.inscription_id
    baseDepositFeesTotal += baseDepositMintRes.total_fee
    const satpoint = `${baseDepositInscriptionId.split('i')[0]}:0:0`
    let sendToOpreturnRes = null
    try {
      if (!baseDepositCommitTxHex) {
        throw new Error('Base deposit commit tx hex is missing')
      }
      saveExtraUtxos(
        [baseDepositCommitTxHex, baseDepositRevealTxHex],
        [baseDepositInscriptionId, satpoint],
      )

      const targetWallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extraOutputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
        baseDepositInscriptionId,
        [],
        targetWallet,
        1,
        extraOutputs,
        feeRate,
      )
    }
    finally {
      clearExtraUtxos()
    }

    if (sendToOpreturnRes == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    baseDepositSendToOpReturnTxHex = sendToOpreturnRes.unsigned_tx_hex
    baseDepositSendToOpReturnTxid = sendToOpreturnRes.txid
    baseDepositFeesTotal += sendToOpreturnRes.tx_fee
  }

  let allowanceInscriptionId = null
  let allowanceCommitTxHex = null
  let allowanceRevealTxHex = null
  let allowanceSendToOpReturnTxHex = null
  let allowanceSendToOpReturnTxid = null
  let allowanceFeesTotal = 0
  if (needsAllowance) {
    const extraTxhexesForAllowance = []
    if (useBaseAvailableBalanceAmt > 0n) {
      extraTxhexesForAllowance.push(
        baseDepositCommitTxHex!,
        baseDepositRevealTxHex!,
        baseDepositSendToOpReturnTxHex!,
      )
    }
    try {
      saveExtraUtxos(extraTxhexesForAllowance, null)
      const allowanceMintRes = await mintAllCheckFees(
        allowanceInscriptionDetails,
        feeRate,
        null,
        null,
        0,
      )
      allowanceCommitTxHex = allowanceMintRes.unsigned_commit_tx_hex
      allowanceRevealTxHex = allowanceMintRes.signed_reveal_tx_hex
      allowanceInscriptionId = allowanceMintRes.inscription_id
      allowanceFeesTotal += allowanceMintRes.total_fee
    }
    finally {
      clearExtraUtxos()
    }

    const satpoint = `${allowanceInscriptionId.split('i')[0]}:0:0`
    let sendToOpreturnRes = null
    try {
      if (!allowanceCommitTxHex) {
        throw new Error('Allowance commit tx hex is missing')
      }
      extraTxhexesForAllowance.push(allowanceCommitTxHex, allowanceRevealTxHex)
      saveExtraUtxos(extraTxhexesForAllowance, [allowanceInscriptionId, satpoint])

      const targetWallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extraOutputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
        allowanceInscriptionId,
        [],
        targetWallet,
        1,
        extraOutputs,
        feeRate,
      )
    }
    finally {
      clearExtraUtxos()
    }

    if (sendToOpreturnRes == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    allowanceSendToOpReturnTxHex = sendToOpreturnRes.unsigned_tx_hex
    allowanceSendToOpReturnTxid = sendToOpreturnRes.txid
    allowanceFeesTotal += sendToOpreturnRes.tx_fee
  }

  const extraUtxos = []
  const extraTxHexes = []
  if (useBaseAvailableBalanceAmt > 0n) {
    if (!baseDepositCommitTxHex || !baseDepositRevealTxHex || !baseDepositSendToOpReturnTxHex) {
      throw new Error('Base deposit transaction hexes are missing')
    }
    extraTxHexes.push(
      baseDepositCommitTxHex,
      baseDepositRevealTxHex,
      baseDepositSendToOpReturnTxHex,
    )

    extraUtxos.push({
      utxo: `${baseDepositSendToOpReturnTxid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }
  if (needsAllowance) {
    if (!allowanceCommitTxHex || !allowanceRevealTxHex || !allowanceSendToOpReturnTxHex) {
      throw new Error('Allowance transaction hexes are missing')
    }
    extraTxHexes.push(allowanceCommitTxHex, allowanceRevealTxHex, allowanceSendToOpReturnTxHex)

    extraUtxos.push({
      utxo: `${allowanceSendToOpReturnTxid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }

  let depositFeesTotal = 0
  let sendToOpreturnRes = null
  try {
    if (extraTxHexes.length > 0) {
      saveExtraUtxos(extraTxHexes, null)
    }
    const depositMintRes = await mintWithExtraInputInCommitFeeRate(
      depositInscriptionDetails,
      extraUtxos,
      feeRate,
      null,
      null,
      0,
    )
    const depositCommitTxHex = depositMintRes.unsigned_commit_tx_hex
    const depositRevealTxHex = depositMintRes.signed_reveal_tx_hex
    const depositInscriptionId = depositMintRes.inscription_id
    const depositSatpoint = `${depositInscriptionId.split('i')[0]}:0:0`
    depositFeesTotal += depositMintRes.total_fee
    extraTxHexes.push(depositCommitTxHex!, depositRevealTxHex!)
    saveExtraUtxos(extraTxHexes, [depositInscriptionId, depositSatpoint])
    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
      depositInscriptionId,
      [],
      targetWallet,
      1,
      [],
      feeRate,
    )
  }
  finally {
    clearExtraUtxos()
  }

  if (sendToOpreturnRes == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  depositFeesTotal += sendToOpreturnRes.tx_fee

  const toReturn = {
    needs_approval: needsAllowance,
    base_deposit_fees_total: baseDepositFeesTotal,
    allowance_fees_total: allowanceFeesTotal,
    deposit_fees_total: depositFeesTotal,
    fee_rate: feeRate,
  }
  return toReturn
}

interface BroadcastWrapOrderRequest {
  commit_txid: string
  commit_txhex: string
  reveal_txid: string
  reveal_txhex: string
  send_to_opreturn_txid: string
  send_to_opreturn_txhex: string
  secret: string
  inscription_id: string
  fee_rate: number
}
interface BroadcastWrapOrderResponse {
  success: boolean
  result: string[] // txid array
}
async function broadcastWrapOrder(
  toSend: BroadcastWrapOrderRequest,
): Promise<BroadcastWrapOrderResponse> {
  const url = getSwapBackendUrl('wrap')

  return fetchWithErrors<BroadcastWrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}
interface EstimateGasWrapOrderResponse {
  success: boolean
  estimated_gas: number
  allocated_gas: number
}
async function estimateGasWrapOrder(
  toSend: BroadcastWrapOrderRequest,
): Promise<EstimateGasWrapOrderResponse> {
  const url = getSwapBackendUrl('estimate_wrap_gas')

  return fetchWithErrors<EstimateGasWrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}
/**
 * Creates and broadcasts a wrap order for swapping BRC-20 tokens. The function first retrieves the necessary swap information and connected wallet details, then generates the required signatures for the deposit. It constructs the call data for the wrap order and mints an inscription with the call data as its content. Finally, it sends the inscription to OP_RETURN and broadcasts the transaction to the network.
 *
 * @param btcAmount The amount of BTC to wrap, represented as a bigint in satoshis.
 * @param feeRate The fee rate to use for the transactions, represented in sats/vbyte.
 *
 * @returns A promise that resolves to an array of transaction IDs related to the wrap order, including the commit transaction, reveal transaction, and the transaction for sending the inscription to OP_RETURN.
 */
export async function createAndBroadcastWrapOrder(
  btcAmount: bigint,
  feeRate: number,
): Promise<string[]> {
  const swapInfo = await getSwapInfo()
  // Get connected wallet
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Sign function
  const signFn = getSignFn(walletInfo.provider)
  const userPaymentWallet = getPaymentWallet()
  const userOrdinalsWallet = getOrdinalsWallet()

  if (!userPaymentWallet)
    throw new Error('Payment wallet not found')
  if (!userPaymentWallet.address)
    throw new Error('Payment wallet address not found')

  if (!userOrdinalsWallet)
    throw new Error('Ordinals wallet not found')
  if (!userOrdinalsWallet.address)
    throw new Error('Ordinals wallet address not found')

  const ordinalsAddr = userOrdinalsWallet.address

  const l1ContractAddress = getSwapContractAddress()

  const swapPubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swapPubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const bip322Signature = await getDepositBIP322Signature({
    btc_address: ordinalsAddr,
    bls_pubkey: swapPubkey,
    token_address: swapInfo.wbtc_address,
  })

  const ordinalsScript = bitcoinjs.address.toOutputScript(ordinalsAddr, getBitcoinNetwork())
  const negSignatureBls12Emergency = await getEmergencyBLSSignature({
    pubkey: swapPubkey,
    ordinals_script: ordinalsScript.toString('hex'),
  })
  const depositDetails = await getDepositSignature({
    btc_address: ordinalsAddr,
    bls_pubkey: swapPubkey,
    token_address: swapInfo.wbtc_address.toLowerCase(),
    bip322_signature: bip322Signature,
    bls12_signature: negSignatureBls12Emergency,
  })
  const ecSignature = depositDetails.edcsa_signature
  const pubkeyIdx = depositDetails.pubkey_idx
  const tokenIdx = depositDetails.token_idx

  const negSignatureBls12 = await getDepositBLSSignature({
    pubkey: swapPubkey,
    pk_idx: BigInt(pubkeyIdx),
  })

  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const callData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint32', 'bytes', 'uint64', 'bytes', 'bytes'],
    [
      swapInfo.wbtc_address,
      tokenIdx,
      Buffer.from(swapPubkey.slice(2), 'hex'),
      pubkeyIdx,
      Buffer.from(negSignatureBls12.slice(2), 'hex'),
      Buffer.from(ecSignature.slice(2), 'hex'),
    ],
  )
  const wrapCallData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [l1ContractAddress, Buffer.from(callData.slice(2), 'hex')],
  )
  const wrapCallDataFull = `0x5608f857${wrapCallData.slice(2)}`

  const depositCalldataCompressed = await compressSmartContractData(wrapCallDataFull)
  const depositContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${swapInfo.wbtc_address}","b":"${depositCalldataCompressed}"}`,
  )
  let estimatedGas = 0
  for (let i = 0; i < 5; i++) {
    const depositContentGasAllocation = depositContent.length * GAS_PER_BYTE
    const neededPadding
      = estimatedGas > depositContentGasAllocation
        ? Math.ceil((estimatedGas - depositContentGasAllocation) / GAS_PER_BYTE)
        : 0
    const paddedDepositContent = Buff.from(
      Buffer.concat([depositContent, Buff.str(' '.repeat(neededPadding))]),
    )
    const depositInscriptionDetails = new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      paddedDepositContent,
    )

    const depositMintRes = await mintWithExtraInputInCommitAll(
      depositInscriptionDetails,
      [],
      feeRate,
      null,
      null,
      0,
      true,
      signFn,
    )
    const depositCommitTxHex = depositMintRes.signedCommitTxHex
    const depositRevealTxHex = depositMintRes.signedRevealTxHex
    const depositInscriptionId = depositMintRes.inscriptionId
    const depositSatpoint = `${depositInscriptionId.split('i')[0]}:0:0`
    const depositSecret = depositMintRes.secret
    let sendToOpreturnRes = null
    try {
      saveExtraUtxos(
        [depositCommitTxHex, depositRevealTxHex],
        [depositInscriptionId, depositSatpoint],
      )

      const targetWallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extraOutputUtxos = [
        // send BTC to WBTC handler
        {
          wallet: new WalletInfo(false, null, swapInfo.wbtc_handler_address, null, null),
          value: Number.parseInt(btcAmount.toString()),
        },
      ]
      sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputAll(
        depositInscriptionId,
        [],
        targetWallet,
        1,
        extraOutputUtxos,
        feeRate,
        true,
        signFn,
      )
    }
    finally {
      clearExtraUtxos()
    }

    if (sendToOpreturnRes == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    const depositSendToOpReturnTxHex = sendToOpreturnRes.signedTxHex
    const depositSendToOpReturnTxid = sendToOpreturnRes.txId

    const toSendForBroadcast: BroadcastWrapOrderRequest = {
      commit_txid: depositMintRes.commitTxId,
      commit_txhex: depositCommitTxHex,
      reveal_txid: depositMintRes.revealTxId,
      reveal_txhex: depositRevealTxHex,
      send_to_opreturn_txid: depositSendToOpReturnTxid,
      send_to_opreturn_txhex: depositSendToOpReturnTxHex,
      secret: depositSecret,
      inscription_id: depositInscriptionId,
      fee_rate: feeRate,
    }
    const estimateGasRes = await estimateGasWrapOrder(toSendForBroadcast)
    const estimatePadded = Math.max(
      estimateGasRes.estimated_gas + 100000,
      estimateGasRes.estimated_gas * 1.2,
    )
    if (estimateGasRes.allocated_gas < estimatePadded) {
      estimatedGas = estimatePadded + 50000
      continue
    }
    const broadcastRes = await broadcastWrapOrder(toSendForBroadcast)

    return broadcastRes.result
  }

  throw new Error('Failed to estimate gas for wrap order after multiple attempts')
}

/**
 * Checks the miner fees required for creating a wrap order for swapping BRC-20 tokens. The function retrieves the necessary swap information and connected wallet details, then generates the required signatures for the deposit. It constructs the call data for the wrap order and estimates the gas fees for minting an inscription with the call data as its content and sending it to OP_RETURN.
 *
 * @param btcAmount The amount of BTC to wrap, represented as a bigint in satoshis.
 * @param feeRate The fee rate to use for the transactions, represented in sats/vbyte.
 *
 * @returns A promise that resolves to an object containing the total miner fees for creating and sending the inscriptions related to the wrap order, as well as the fee rate used for the calculations.
 */
export async function getMinerFeesOfWrapOrder(
  btcAmount: bigint,
  feeRate: number,
): Promise<{ total_fee: number, fee_rate: number }> {
  const swapInfo = await getSwapInfo()
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  // Sign function
  const userPaymentWallet = getPaymentWallet()

  if (!userPaymentWallet)
    throw new Error('Payment wallet not found')
  if (!userPaymentWallet.address)
    throw new Error('Payment wallet address not found')

  const l1ContractAddress = getSwapContractAddress()

  const swapPubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swapPubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ecSignature = `0x${'00'.repeat(64)}` // dummy
  const pubkeyIdx = 1 // dummy
  const tokenIdx = 1 // dummy

  const negSignatureBls12 = await getDepositBLSSignature({
    pubkey: swapPubkey,
    pk_idx: BigInt(pubkeyIdx),
  })

  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const callData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint32', 'bytes', 'uint64', 'bytes', 'bytes'],
    [
      swapInfo.wbtc_address,
      tokenIdx,
      Buffer.from(swapPubkey.slice(2), 'hex'),
      pubkeyIdx,
      Buffer.from(negSignatureBls12.slice(2), 'hex'),
      Buffer.from(ecSignature.slice(2), 'hex'),
    ],
  )
  const wrapCallData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [l1ContractAddress, Buffer.from(callData.slice(2), 'hex')],
  )
  const wrapCallDataFull = `0x5608f857${wrapCallData.slice(2)}`

  const depositCalldataCompressed = await compressSmartContractData(wrapCallDataFull)
  const depositContent = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${swapInfo.wbtc_address}","b":"${depositCalldataCompressed}"}`,
  )
  const depositInscriptionDetails = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    depositContent,
  )

  let depositFeesTotal = 0
  const depositMintRes = await mintWithExtraInputInCommitFeeRate(
    depositInscriptionDetails,
    [],
    feeRate,
    null,
    null,
    0,
  )
  const depositCommitTxHex = depositMintRes.unsigned_commit_tx_hex
  const depositRevealTxHex = depositMintRes.signed_reveal_tx_hex
  const depositInscriptionId = depositMintRes.inscription_id
  const depositSatpoint = `${depositInscriptionId.split('i')[0]}:0:0`
  depositFeesTotal += depositMintRes.total_fee
  let sendToOpreturnRes = null
  try {
    saveExtraUtxos(
      [depositCommitTxHex, depositRevealTxHex],
      [depositInscriptionId, depositSatpoint],
    )

    const targetWallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    const extraOutputUtxos = [
      // send BTC to WBTC handler
      {
        wallet: new WalletInfo(false, null, swapInfo.wbtc_handler_address, null, null),
        value: Number.parseInt(btcAmount.toString()),
      },
    ]
    sendToOpreturnRes = await sendInscriptionToOpReturnWithExtraInputsAndExtraOutputFeeRate(
      depositInscriptionId,
      [],
      targetWallet,
      1,
      extraOutputUtxos,
      feeRate,
    )
  }
  finally {
    clearExtraUtxos()
  }

  if (sendToOpreturnRes == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  depositFeesTotal += sendToOpreturnRes.tx_fee

  const toReturn = {
    total_fee: depositFeesTotal,
    fee_rate: feeRate,
  }
  return toReturn
}

/**
 * Calculates the expected amounts of tokens A and B to be added to the liquidity pool, as well as the amount of liquidity tokens that will be minted, based on the input parameters for adding liquidity. The function retrieves the necessary swap information and uses a proxy to check the current balances and reserves of the tokens in the liquidity pool. It also requests the miner fee for adding liquidity and then calls the addLiquidityRequest function to get the expected results.
 *
 * @param token1Addr The address of the first token to be added to the liquidity pool.
 * @param token2Addr The address of the second token to be added to the liquidity pool.
 * @param amt1 The amount of the first token to be added to the liquidity pool, represented as a bigint.
 * @param amt2 The amount of the second token to be added to the liquidity pool, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the expected amounts of tokens A and B to be added to the liquidity pool, as well as the amount of liquidity tokens that will be minted, represented as bigints.
 */
export async function getAddLiquidityResult(
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
): Promise<{ amountA: bigint, amountB: bigint, liquidity: bigint }> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('add_liquidity')

  const result = await addLiquidityRequest(
    proxy,
    pubkey,
    token1Addr,
    token2Addr,
    amt1,
    amt2,
    0n, // minamt1
    0n, // minamt2
    '', // bls_signature
    0n, // nonce
    0n, // token1FeeBps
    0n, // token2FeeBps
    btcFee, // btc_fee
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create add liquidity request.')
  }
  if (!result.data) {
    throw new Error('No data returned from add liquidity request.')
  }

  return result.data
}

interface AddLiquiditySignatureRequest {
  token1_addr: string
  token2_addr: string
  amt1: string
  amt2: string
  minamt1: string
  minamt2: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
}
async function getAddLiquiditySignature(
  orderParams: AddLiquiditySignatureRequest,
): Promise<string> {
  orderParams.token1_addr = orderParams.token1_addr.toLowerCase()
  orderParams.token2_addr = orderParams.token2_addr.toLowerCase()

  const signatureText = `Add Liquidity Order:
Token 1 Address: ${orderParams.token1_addr}
Token 2 Address: ${orderParams.token2_addr}
Amount 1: ${orderParams.amt1}
Amount 2: ${orderParams.amt2}
Minimum Amount 1: ${orderParams.minamt1}
Minimum Amount 2: ${orderParams.minamt2}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}

By signing this message, you authorize the creation of an add liquidity order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface AddLiquidityBLSSignatureRequest {
  pubkey: string
  nonce: bigint
  token1_addr: string
  token2_addr: string
  amt1: bigint
  amt2: bigint
  minamt1: bigint
  minamt2: bigint
  token1FeeBps: bigint
  token2FeeBps: bigint
  btc_fee: bigint
}
async function getAddLiquidityBLSSignature(
  params: AddLiquidityBLSSignatureRequest,
): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '01' // add liquidity
  msg += params.token1_addr.slice(2).padStart(40, '0')
  msg += params.token2_addr.slice(2).padStart(40, '0')
  msg += params.amt1.toString(16).padStart(64, '0')
  msg += params.amt2.toString(16).padStart(64, '0')
  msg += params.minamt1.toString(16).padStart(64, '0')
  msg += params.minamt2.toString(16).padStart(64, '0')
  msg += params.token1FeeBps.toString(16).padStart(64, '0')
  msg += params.token2FeeBps.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface AddLiquidityOrderRequest {
  pubkey: string
  token1_addr: string
  token2_addr: string
  amt1: string
  amt2: string
  minamt1: string
  minamt2: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
}
interface AddLiquidityOrderResponse {
  success: boolean
}
async function sendAddLiquidityOrder(
  toSend: AddLiquidityOrderRequest,
): Promise<AddLiquidityOrderResponse> {
  const url = getSwapBackendUrl('add_liq_req')

  return fetchWithErrors<AddLiquidityOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends an add liquidity order for a decentralized exchange. The function retrieves the necessary swap information and connected wallet details, calculates the minimum amounts based on the provided slippage, and generates the required signatures for the order. It then constructs the order parameters and sends the add liquidity order to the backend API.
 *
 * @param token1Addr The address of the first token to be added to the liquidity pool.
 * @param token2Addr The address of the second token to be added to the liquidity pool.
 * @param amt1 The amount of the first token to be added to the liquidity pool, represented as a bigint.
 * @param amt2 The amount of the second token to be added to the liquidity pool, represented as a bigint.
 * @param slippageBPS The slippage in basis points to be applied when calculating the minimum amounts for the liquidity order.
 *
 * @returns A promise that resolves to an object indicating the success of the add liquidity order request.
 */
export async function prepareAndSendAddLiquidityOrder(
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<AddLiquidityOrderResponse> {
  const swapInfo = await getSwapInfo()

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const minamt1 = (amt1 * (10000n - slippageBPS)) / 10000n
  const minamt2 = (amt2 * (10000n - slippageBPS)) / 10000n
  const token1FeeBPS = 0n
  const token2FeeBPS = 0n
  if (
    token1Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
    && token2Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('add_liquidity')
  const bip322Signature = await getAddLiquiditySignature({
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    amt1: amt1.toString(),
    amt2: amt2.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
  })

  const blsSignature = await getAddLiquidityBLSSignature({
    pubkey,
    nonce,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    amt1,
    amt2,
    minamt1,
    minamt2,
    token1FeeBps: token1FeeBPS,
    token2FeeBps: token2FeeBPS,
    btc_fee: btcFee,
  })

  return await sendAddLiquidityOrder({
    pubkey,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    amt1: amt1.toString(),
    amt2: amt2.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
  })
}

/**
 * Calculates the expected amounts of tokens A and B to be removed from the liquidity pool, as well as the amount of liquidity tokens that will be burned, based on the input parameters for removing liquidity. The function retrieves the necessary swap information and uses a proxy to check the current balances and reserves of the tokens in the liquidity pool. It also requests the miner fee for removing liquidity and then calls the removeLiquidityRequest function to get the expected results.
 *
 * @param token1Addr The address of the first token to be removed from the liquidity pool.
 * @param token2Addr The address of the second token to be removed from the liquidity pool.
 * @param lpAmt The amount of liquidity tokens to be burned, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the expected amounts of tokens A and B to be removed from the liquidity pool, as well as the amount of liquidity tokens that will be burned, represented as bigints.
 */
export async function getRemoveLiquidityResult(
  token1Addr: string,
  token2Addr: string,
  lpAmt: bigint,
): Promise<{ amountA: bigint, amountB: bigint, liquidity: bigint }> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('remove_liquidity')
  const result = await removeLiquidityRequest(
    proxy,
    pubkey,
    token1Addr,
    token2Addr,
    lpAmt,
    0n, // minamt1
    0n, // minamt2
    '', // bls_signature
    0n, // nonce
    0n, // token1FeeBps
    0n, // token2FeeBps
    btcFee, // btc_fee
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create remove liquidity request.')
  }
  if (!result.data) {
    throw new Error('No data returned from remove liquidity request.')
  }

  return result.data
}

interface RemoveLiquiditySignatureRequest {
  token1_addr: string
  token2_addr: string
  lp_amt: string
  minamt1: string
  minamt2: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
}
async function getRemoveLiquiditySignature(
  orderParams: RemoveLiquiditySignatureRequest,
): Promise<string> {
  orderParams.token1_addr = orderParams.token1_addr.toLowerCase()
  orderParams.token2_addr = orderParams.token2_addr.toLowerCase()

  const signatureText = `Remove Liquidity Order:
Token 1 Address: ${orderParams.token1_addr}
Token 2 Address: ${orderParams.token2_addr}
LP Amount: ${orderParams.lp_amt}
Minimum Amount 1: ${orderParams.minamt1}
Minimum Amount 2: ${orderParams.minamt2}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}

By signing this message, you authorize the creation of a remove liquidity order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface RemoveLiquidityBLSSignatureRequest {
  pubkey: string
  nonce: bigint
  token1_addr: string
  token2_addr: string
  lp_amt: bigint
  minamt1: bigint
  minamt2: bigint
  token1FeeBps: bigint
  token2FeeBps: bigint
  btc_fee: bigint
}
async function getRemoveLiquidityBLSSignature(
  params: RemoveLiquidityBLSSignatureRequest,
): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '02' // remove liquidity
  msg += params.token1_addr.slice(2).padStart(40, '0')
  msg += params.token2_addr.slice(2).padStart(40, '0')
  msg += params.lp_amt.toString(16).padStart(64, '0')
  msg += params.minamt1.toString(16).padStart(64, '0')
  msg += params.minamt2.toString(16).padStart(64, '0')
  msg += params.token1FeeBps.toString(16).padStart(64, '0')
  msg += params.token2FeeBps.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface RemoveLiquidityOrderRequest {
  pubkey: string
  token1_addr: string
  token2_addr: string
  lp_amt: string
  minamt1: string
  minamt2: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
}
interface RemoveLiquidityOrderResponse {
  success: boolean
}
async function sendRemoveLiquidityOrder(
  toSend: RemoveLiquidityOrderRequest,
): Promise<RemoveLiquidityOrderResponse> {
  const url = getSwapBackendUrl('remove_liq_req')

  return fetchWithErrors<RemoveLiquidityOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends a remove liquidity order for a decentralized exchange. The function retrieves the necessary swap information and connected wallet details, calculates the minimum amounts based on the provided slippage, and generates the required signatures for the order. It then constructs the order parameters and sends the remove liquidity order to the backend API.
 *
 * @param token1Addr The address of the first token to be removed from the liquidity pool.
 * @param token2Addr The address of the second token to be removed from the liquidity pool.
 * @param lpAmt The amount of liquidity tokens to be burned, represented as a bigint.
 * @param amt1 The expected amount of the first token to be removed from the liquidity pool, represented as a bigint.
 * @param amt2 The expected amount of the second token to be removed from the liquidity pool, represented as a bigint.
 * @param slippageBPS The slippage in basis points to be applied when calculating the minimum amounts for the liquidity order.
 *
 * @returns A promise that resolves to an object indicating the success of the remove liquidity order request.
 */
export async function prepareAndSendRemoveLiquidityOrder(
  token1Addr: string,
  token2Addr: string,
  lpAmt: bigint,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<RemoveLiquidityOrderResponse> {
  const swapInfo = await getSwapInfo()

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const minamt1 = (amt1 * (10000n - slippageBPS)) / 10000n
  const minamt2 = (amt2 * (10000n - slippageBPS)) / 10000n
  const token1FeeBPS = 0n
  const token2FeeBPS = 0n
  if (
    token1Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
    && token2Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('remove_liquidity')
  const bip322Signature = await getRemoveLiquiditySignature({
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    lp_amt: lpAmt.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
  })

  const blsSignature = await getRemoveLiquidityBLSSignature({
    pubkey,
    nonce,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    lp_amt: lpAmt,
    minamt1,
    minamt2,
    token1FeeBps: token1FeeBPS,
    token2FeeBps: token2FeeBPS,
    btc_fee: btcFee,
  })

  return await sendRemoveLiquidityOrder({
    pubkey,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    lp_amt: lpAmt.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
  })
}

async function getSwapFeesBps(
  token1Addr: string,
  token2Addr: string,
): Promise<{ token1FeeBps: bigint, token2FeeBps: bigint }> {
  const swapInfo = await getSwapInfo()

  let token1FeeBps = 25n
  let token2FeeBps = 0n
  if (
    token1Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
    && token2Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }
  if (token1Addr.toLowerCase() !== swapInfo.wbtc_address.toLowerCase()) {
    token1FeeBps = 0n
    token2FeeBps = 25n
  }

  return { token1FeeBps, token2FeeBps }
}

/**
 * Calculates the expected output amount, quoted price, and price impact for a token swap operation. The function retrieves the necessary swap information and connected wallet details, then uses a proxy to check the current balances and reserves of the tokens in the liquidity pool. It also requests the miner fee for swapping and gets the fee basis points for the tokens involved in the swap. Finally, it calls the swapRequest function to get the expected results based on the input parameters.
 *
 * @param tokenInAddr The address of the token being swapped from.
 * @param tokenOutAddr The address of the token being swapped to.
 * @param amtIn The amount of the input token to be swapped, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the expected output amount of the token being swapped to, the quoted price for the swap, the price impact in basis points, and the fee breakdown (see `SwapFees` — `amount_out` is net of the pool fee only, with the rest charged on top).
 */
export async function getSwapResult(
  tokenInAddr: string,
  tokenOutAddr: string,
  amtIn: bigint,
): Promise<{
  amount_out: bigint
  quoted_price: number
  price_impact_bps: bigint
  fees: SwapFees
}> {
  const swapInfo = await getSwapInfo()
  // saveInfo is handled by assertPoolExists below (single source of truth).
  await assertPoolExists(tokenInAddr, tokenOutAddr)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(tokenInAddr, tokenOutAddr)
  const result = await swapRequest(
    proxy,
    pubkey,
    tokenInAddr,
    tokenOutAddr,
    amtIn,
    0n, // min_out_amt
    '', // bls_signature
    0n, // nonce
    token1FeeBps,
    token2FeeBps,
    btcFee,
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create swap request.')
  }
  if (!result.amounts) {
    throw new Error('No data returned from swap request.')
  }
  if (result.amounts.length < 2) {
    throw new Error('Invalid amounts returned from swap request.')
  }

  const decimalsOfIn = await getTokenDecimals(tokenInAddr)
  const decimalsOfOut = await getTokenDecimals(tokenOutAddr)
  const quotedPrice
    = tokenInAddr.toLowerCase() === swapInfo.wbtc_address.toLowerCase()
      ? (amtIn * 10n ** BigInt(decimalsOfOut) * 100n) / result.amounts[1]!
      : (result.amounts[1]! * 10n ** BigInt(decimalsOfIn) * 100n) / amtIn
  const quotedPriceNumber = Number(quotedPrice) / 100.0

  return {
    amount_out: result.amounts[1]!,
    quoted_price: quotedPriceNumber,
    price_impact_bps: result.price_impact_bps,
    fees: buildSwapFees(amtIn, result.amounts[1]!, token1FeeBps, token2FeeBps, btcFee),
  }
}

interface SwapOrderSignatureRequest {
  token1_addr: string
  token2_addr: string
  in_amt: string
  min_out_amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  referrer_pubkey?: string
  ref_return_bps?: string
}
async function getSwapOrderSignature(orderParams: SwapOrderSignatureRequest): Promise<string> {
  orderParams.token1_addr = orderParams.token1_addr.toLowerCase()
  orderParams.token2_addr = orderParams.token2_addr.toLowerCase()
  orderParams.referrer_pubkey = orderParams.referrer_pubkey?.startsWith('0x')
    ? orderParams.referrer_pubkey.slice(2)
    : orderParams.referrer_pubkey

  const signatureText = `Swap Order:
Token 1 Address: ${orderParams.token1_addr}
Token 2 Address: ${orderParams.token2_addr}
Input Amount: ${orderParams.in_amt}
Minimum Output Amount: ${orderParams.min_out_amt}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}
${orderParams.referrer_pubkey ? `Referrer Pubkey: ${orderParams.referrer_pubkey}\n` : ''}${orderParams.ref_return_bps && BigInt(orderParams.ref_return_bps) > 0n ? `Referrer Return Bps: ${orderParams.ref_return_bps}\n` : ''}
By signing this message, you authorize the creation of a swap order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface SwapBLSSignatureRequest {
  pubkey: string
  nonce: bigint
  token1_addr: string
  token2_addr: string
  in_amt: bigint
  min_out_amt: bigint
  token1FeeBps: bigint
  token2FeeBps: bigint
  btc_fee: bigint
  referrer_pubkey?: string
  ref_return_bps?: bigint
}
async function getSwapBLSSignature(params: SwapBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey
  params.referrer_pubkey = params.referrer_pubkey?.startsWith('0x')
    ? params.referrer_pubkey.slice(2)
    : params.referrer_pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '03' // swap1
  msg += params.token1_addr.slice(2).padStart(64, '0') // NOTE: these are padded to 64 not 40 because address[] has padding bug address, address does not
  msg += params.token2_addr.slice(2).padStart(64, '0') // NOTE: these are padded to 64 not 40 because address[] has padding bug address, address does not
  msg += params.in_amt.toString(16).padStart(64, '0')
  msg += params.min_out_amt.toString(16).padStart(64, '0')
  msg += params.token1FeeBps.toString(16).padStart(64, '0')
  msg += params.token2FeeBps.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')
  if (params.referrer_pubkey) {
    msg += ethers.keccak256(Buffer.from(params.referrer_pubkey, 'hex')).slice(2)
    msg += REFERRER_FEE_BPS.toString(16).padStart(8, '0')
    if (params.ref_return_bps && params.ref_return_bps > 0n) {
      msg += params.ref_return_bps.toString(16).padStart(8, '0')
    }
  }

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface SwapOrderRequest {
  pubkey: string
  token1_addr: string
  token2_addr: string
  in_amt: string
  min_out_amt: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
  referrer_pubkey?: string
  referrer_id?: string
}
interface SwapOrderResponse {
  success: boolean
}
async function sendSwapOrder(toSend: SwapOrderRequest): Promise<SwapOrderResponse> {
  const url = getSwapBackendUrl('swap')

  return fetchWithErrors<SwapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends a swap order for BiS Swap. The function retrieves the necessary swap information and connected wallet details, calculates the minimum output amount based on the provided slippage, and generates the required signatures for the order. It then constructs the order parameters and sends the swap order to the backend API.
 *
 * @param token1Addr The address of the token being swapped from.
 * @param token2Addr The address of the token being swapped to.
 * @param amt1 The amount of the input token to be swapped, represented as a bigint.
 * @param amt2 The amount of the output token expected from the swap, represented as a bigint.
 * @param slippageBPS The slippage in basis points to be applied when calculating the minimum amounts for the liquidity order.
 * @param referrerId An optional referral ID. When provided and valid, a share of the swap fee is credited to the referrer; an invalid referral is ignored and the swap proceeds normally.
 *
 * @returns A promise that resolves to an object indicating the success of the swap order request.
 */
export async function prepareAndSendSwapOrder(
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
  referrerId?: string,
): Promise<SwapOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  await assertPoolExists(token1Addr, token2Addr)

  const minOutAmt = (amt2 * (10000n - slippageBPS)) / 10000n

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token1Addr, token2Addr)
  const { referrerPubkey, refReturnBps } = referrerId
    ? await tryGetSwapReferrerInfo(pubkey, referrerId)
    : { referrerPubkey: undefined, refReturnBps: undefined }
  const bip322Signature = await getSwapOrderSignature({
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    in_amt: amt1.toString(),
    min_out_amt: minOutAmt.toString(),
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btcFee.toString(),
    referrer_pubkey: referrerPubkey,
    ref_return_bps: refReturnBps ? refReturnBps.toString() : undefined,
  })

  const blsSignature = await getSwapBLSSignature({
    pubkey,
    nonce,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    in_amt: amt1,
    min_out_amt: minOutAmt,
    token1FeeBps,
    token2FeeBps,
    btc_fee: btcFee,
    referrer_pubkey: referrerPubkey,
    ref_return_bps: refReturnBps,
  })

  return await sendSwapOrder({
    pubkey,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    in_amt: amt1.toString(),
    min_out_amt: minOutAmt.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
    referrer_pubkey: referrerPubkey,
    referrer_id: referrerPubkey ? referrerId : undefined,
  })
}

/**
 * Calculates the expected input amount, quoted price, and price impact for a token swap operation using the swap2 algorithm. The function retrieves the necessary swap information and connected wallet details, then uses a proxy to check the current balances and reserves of the tokens in the liquidity pool. It also requests the miner fee for swapping and gets the fee basis points for the tokens involved in the swap. Finally, it calls the swap2Request function to get the expected results based on the input parameters.
 *
 * @param tokenInAddr The address of the token being swapped from.
 * @param tokenOutAddr The address of the token being swapped to.
 * @param amtOut The amount of the output token expected from the swap, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the expected input amount of the token being swapped from, the quoted price for the swap, the price impact in basis points, and the fee breakdown (see `SwapFees` — `amount_in` covers the pool fee only, with the rest charged on top).
 */
export async function getSwap2Result(
  tokenInAddr: string,
  tokenOutAddr: string,
  amtOut: bigint,
): Promise<{
  amount_in: bigint
  quoted_price: number
  price_impact_bps: bigint
  fees: SwapFees
}> {
  const swapInfo = await getSwapInfo()
  // saveInfo is handled by assertPoolExists below (single source of truth).
  await assertPoolExists(tokenInAddr, tokenOutAddr)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(tokenInAddr, tokenOutAddr)
  const result = await swap2Request(
    proxy,
    pubkey,
    tokenInAddr,
    tokenOutAddr,
    BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), // max_in_amt
    amtOut,
    '', // bls_signature
    0n, // nonce
    token1FeeBps,
    token2FeeBps,
    btcFee,
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create swap request.')
  }
  if (!result.amounts) {
    throw new Error('No data returned from swap request.')
  }
  if (result.amounts.length < 2) {
    throw new Error('Invalid data returned from swap request.')
  }

  const decimalsOfIn = await getTokenDecimals(tokenInAddr)
  const decimalsOfOut = await getTokenDecimals(tokenOutAddr)
  const quotedPrice
    = tokenInAddr.toLowerCase() === swapInfo.wbtc_address.toLowerCase()
      ? (result.amounts[0]! * 10n ** BigInt(decimalsOfOut) * 100n) / amtOut
      : (amtOut * 10n ** BigInt(decimalsOfIn) * 100n) / result.amounts[0]!

  const quotedPriceNumber = Number(quotedPrice) / 100.0

  return {
    amount_in: result.amounts[0]!,
    quoted_price: quotedPriceNumber,
    price_impact_bps: result.price_impact_bps,
    fees: buildSwapFees(result.amounts[0]!, amtOut, token1FeeBps, token2FeeBps, btcFee),
  }
}

interface Swap2OrderSignatureRequest {
  token1_addr: string
  token2_addr: string
  max_in_amt: string
  out_amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  referrer_pubkey?: string
  ref_return_bps?: string
}
async function getSwap2OrderSignature(orderParams: Swap2OrderSignatureRequest): Promise<string> {
  orderParams.token1_addr = orderParams.token1_addr.toLowerCase()
  orderParams.token2_addr = orderParams.token2_addr.toLowerCase()
  orderParams.referrer_pubkey = orderParams.referrer_pubkey?.startsWith('0x')
    ? orderParams.referrer_pubkey.slice(2)
    : orderParams.referrer_pubkey

  const signatureText = `Swap Order:
Token 1 Address: ${orderParams.token1_addr}
Token 2 Address: ${orderParams.token2_addr}
Maximum Input Amount: ${orderParams.max_in_amt}
Output Amount: ${orderParams.out_amt}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}
${orderParams.referrer_pubkey ? `Referrer Pubkey: ${orderParams.referrer_pubkey}\n` : ''}${orderParams.ref_return_bps && BigInt(orderParams.ref_return_bps) > 0n ? `Referrer Return Bps: ${orderParams.ref_return_bps}\n` : ''}
By signing this message, you authorize the creation of a swap order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface Swap2BLSSignatureRequest {
  pubkey: string
  nonce: bigint
  token1_addr: string
  token2_addr: string
  max_in_amt: bigint
  out_amt: bigint
  token1FeeBps: bigint
  token2FeeBps: bigint
  btc_fee: bigint
  referrer_pubkey?: string
  ref_return_bps?: bigint
}
async function getSwap2BLSSignature(params: Swap2BLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey
  params.referrer_pubkey = params.referrer_pubkey?.startsWith('0x')
    ? params.referrer_pubkey.slice(2)
    : params.referrer_pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '04' // swap2
  msg += params.token1_addr.slice(2).padStart(64, '0') // NOTE: these are padded to 64 not 40 because address[] has padding bug address, address does not
  msg += params.token2_addr.slice(2).padStart(64, '0') // NOTE: these are padded to 64 not 40 because address[] has padding bug address, address does not
  msg += params.max_in_amt.toString(16).padStart(64, '0')
  msg += params.out_amt.toString(16).padStart(64, '0')
  msg += params.token1FeeBps.toString(16).padStart(64, '0')
  msg += params.token2FeeBps.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')
  if (params.referrer_pubkey) {
    msg += ethers.keccak256(Buffer.from(params.referrer_pubkey, 'hex')).slice(2)
    msg += REFERRER_FEE_BPS.toString(16).padStart(8, '0')
    if (params.ref_return_bps && params.ref_return_bps > 0n) {
      msg += params.ref_return_bps.toString(16).padStart(8, '0')
    }
  }

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface Swap2OrderRequest {
  pubkey: string
  token1_addr: string
  token2_addr: string
  max_in_amt: string
  out_amt: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
  referrer_pubkey?: string
  referrer_id?: string
}
interface Swap2OrderResponse {
  success: boolean
}
async function sendSwap2Order(toSend: Swap2OrderRequest): Promise<Swap2OrderResponse> {
  const url = getSwapBackendUrl('swap2')

  return fetchWithErrors<Swap2OrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends a swap order using the swap2 algorithm for BiS Swap. The function retrieves the necessary swap information and connected wallet details, calculates the maximum input amount based on the provided slippage, and generates the required signatures for the order. It then constructs the order parameters and sends the swap order to the backend API.
 *
 * @param token1Addr The address of the token being swapped from.
 * @param token2Addr The address of the token being swapped to.
 * @param amt1 The amount of the input token to be swapped, represented as a bigint.
 * @param amt2 The amount of the output token expected from the swap, represented as a bigint.
 * @param slippageBPS The slippage in basis points to be applied when calculating the maximum input amount for the swap order.
 * @param referrerId An optional referral ID. When provided and valid, a share of the swap fee is credited to the referrer; an invalid referral is ignored and the swap proceeds normally.
 *
 * @returns A promise that resolves to an object indicating the success of the swap order request.
 */
export async function prepareAndSendSwap2Order(
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
  referrerId?: string,
): Promise<Swap2OrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  await assertPoolExists(token1Addr, token2Addr)

  const maxInAmt = (amt1 * (10000n + slippageBPS)) / 10000n

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token1Addr, token2Addr)
  const { referrerPubkey, refReturnBps } = referrerId
    ? await tryGetSwapReferrerInfo(pubkey, referrerId)
    : { referrerPubkey: undefined, refReturnBps: undefined }
  const bip322Signature = await getSwap2OrderSignature({
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    max_in_amt: maxInAmt.toString(),
    out_amt: amt2.toString(),
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btcFee.toString(),
    referrer_pubkey: referrerPubkey,
    ref_return_bps: refReturnBps ? refReturnBps.toString() : undefined,
  })

  const blsSignature = await getSwap2BLSSignature({
    pubkey,
    nonce,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    max_in_amt: maxInAmt,
    out_amt: amt2,
    token1FeeBps,
    token2FeeBps,
    btc_fee: btcFee,
    referrer_pubkey: referrerPubkey,
    ref_return_bps: refReturnBps,
  })

  return await sendSwap2Order({
    pubkey,
    token1_addr: token1Addr,
    token2_addr: token2Addr,
    max_in_amt: maxInAmt.toString(),
    out_amt: amt2.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
    referrer_pubkey: referrerPubkey,
    referrer_id: referrerPubkey ? referrerId : undefined,
  })
}

function btcAddressToEvmAddress(btcAddr: string): string {
  const network = getBitcoinNetwork()
  return `0x${ethers.keccak256(bitcoinjs.address.toOutputScript(btcAddr, network)).slice(26)}`
}

/**
 * Prepares and sends a withdraw request to transfer tokens from the smart wallet to an ordinal wallet. The function retrieves the necessary swap information and connected wallet details, converts the target ordinal Bitcoin address to an Ethereum-compatible address, and generates the required signatures for the withdraw request. It then constructs the withdraw request parameters and sends the request to the backend API.
 *
 * @param tokenAddress The address of the token to be withdrawn.
 * @param ordinalAddress The Bitcoin address of the target ordinal wallet.
 * @param amt The amount of the token to be withdrawn, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the amount withdrawn, represented as a bigint.
 */
export async function getWithdrawToOrdinalWalletResult(
  tokenAddress: string,
  ordinalAddress: string,
  amt: bigint,
): Promise<{ amt: bigint }> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const targetBtcAddr = ordinalAddress
  const targetAddress = btcAddressToEvmAddress(targetBtcAddr)

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('withdraw')
  const result = await withdrawRequest(
    proxy,
    pubkey,
    tokenAddress,
    targetAddress,
    amt,
    '', // bls_signature
    0n, // nonce
    btcFee,
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create withdraw request.')
  }
  if (!result.data) {
    throw new Error('No data returned from withdraw request.')
  }

  return { amt: result.data.amt }
}

/**
 * Prepares and sends a withdraw request to transfer tokens from the smart wallet to the user's own ordinal wallet. The function retrieves the necessary swap information and connected wallet details, obtains the user's ordinal wallet address, converts it to an Ethereum-compatible address, and generates the required signatures for the withdraw request. It then constructs the withdraw request parameters and sends the request to the backend API.
 *
 * @param tokenAddress The address of the token to be withdrawn.
 * @param amt The amount of the token to be withdrawn, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the amount withdrawn, represented as a bigint.
 */
export async function getWithdrawToSelfOrdinalWalletResult(
  tokenAddress: string,
  amt: bigint,
): Promise<{ amt: bigint }> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ordinalsWallet = getOrdinalsWallet()
  if (!ordinalsWallet || !ordinalsWallet.address) {
    throw new Error('Ordinals wallet not found. Please generate an ordinals wallet first.')
  }
  const ordinalAddress = ordinalsWallet.address

  const targetBtcAddr = ordinalAddress
  const targetAddress = btcAddressToEvmAddress(targetBtcAddr)

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('withdraw')
  const result = await withdrawRequest(
    proxy,
    pubkey,
    tokenAddress,
    targetAddress,
    amt,
    '', // bls_signature
    0n, // nonce
    btcFee,
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create withdraw request.')
  }
  if (!result.data) {
    throw new Error('No data returned from withdraw request.')
  }

  return { amt: result.data.amt }
}

interface WithdrawOrderSignatureRequest {
  token_address: string
  target_addr: string
  amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
}
async function getWithdrawOrderSignature(
  orderParams: WithdrawOrderSignatureRequest,
): Promise<string> {
  orderParams.token_address = orderParams.token_address.toLowerCase()
  orderParams.target_addr = orderParams.target_addr.toLowerCase()

  const signatureText = `Withdraw Order:
Token Address: ${orderParams.token_address}
Target Address: ${orderParams.target_addr}
Amount: ${orderParams.amt}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}

By signing this message, you authorize the creation of a withdraw order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface WithdrawBLSSignatureRequest {
  pubkey: string
  nonce: bigint
  token_addr: string
  target_addr: string
  amt: bigint
  btc_fee: bigint
}
async function getWithdrawBLSSignature(params: WithdrawBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '05' // withdraw
  msg += params.token_addr.slice(2).padStart(40, '0')
  msg += params.target_addr.slice(2).padStart(40, '0')
  msg += params.amt.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface WithdrawOrderRequest {
  pubkey: string
  token_addr: string
  target_addr: string
  amt: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
}
export interface WithdrawOrderResponse {
  success: boolean
}
async function sendWithdrawOrder(toSend: WithdrawOrderRequest): Promise<WithdrawOrderResponse> {
  const url = getSwapBackendUrl('withdraw')

  return fetchWithErrors<WithdrawOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends a withdraw order to transfer tokens from the smart wallet to an ordinal wallet. The function retrieves the necessary swap information and connected wallet details, converts the target ordinal Bitcoin address to an Ethereum-compatible address, and generates the required signatures for the withdraw order. It then constructs the withdraw order parameters and sends the order to the backend API.
 *
 * @param tokenAddr The address of the token to be withdrawn.
 * @param ordinalAddr The Bitcoin address of the target ordinal wallet.
 * @param amt The amount of the token to be withdrawn, represented as a bigint.
 *
 * @returns A promise that resolves to an object indicating the success of the withdraw order request.
 */
export async function prepareAndSendWithdrawOrderToOrdinalWallet(
  tokenAddr: string,
  ordinalAddr: string,
  amt: bigint,
): Promise<WithdrawOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const targetBtcAddr = ordinalAddr
  const targetAddr = btcAddressToEvmAddress(targetBtcAddr)

  const token1FeeBPS = 0n
  const token2FeeBPS = 0n

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('withdraw')
  const bip322Signature = await getWithdrawOrderSignature({
    token_address: tokenAddr,
    target_addr: targetAddr,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
  })

  const blsSignature = await getWithdrawBLSSignature({
    pubkey,
    nonce,
    token_addr: tokenAddr,
    target_addr: targetAddr,
    amt,
    btc_fee: btcFee,
  })

  return await sendWithdrawOrder({
    pubkey,
    token_addr: tokenAddr,
    target_addr: targetAddr,
    amt: amt.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
  })
}

/**
 * Prepares and sends a withdraw order to transfer tokens from the smart wallet to the user's own ordinal wallet. The function retrieves the necessary swap information and connected wallet details, obtains the user's ordinal wallet address, converts it to an Ethereum-compatible address, and generates the required signatures for the withdraw order. It then constructs the withdraw order parameters and sends the order to the backend API.
 *
 * @param tokenAddr The address of the token to be withdrawn.
 * @param amt The amount of the token to be withdrawn, represented as a bigint.
 *
 * @returns A promise that resolves to an object indicating the success of the withdraw order request.
 */
export async function prepareAndSendWithdrawOrderToSelfOrdinalWallet(
  tokenAddr: string,
  amt: bigint,
): Promise<WithdrawOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ordinalsWallet = getOrdinalsWallet()
  if (!ordinalsWallet || !ordinalsWallet.address) {
    throw new Error('Ordinals wallet not found. Please set up your ordinals wallet first.')
  }
  const targetBtcAddr = ordinalsWallet.address
  const targetAddr = btcAddressToEvmAddress(targetBtcAddr)

  const token1FeeBPS = 0n
  const token2FeeBPS = 0n

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('withdraw')
  const bip322Signature = await getWithdrawOrderSignature({
    token_address: tokenAddr,
    target_addr: targetAddr,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
  })

  const blsSignature = await getWithdrawBLSSignature({
    pubkey,
    nonce,
    token_addr: tokenAddr,
    target_addr: targetAddr,
    amt,
    btc_fee: btcFee,
  })

  return await sendWithdrawOrder({
    pubkey,
    token_addr: tokenAddr,
    target_addr: targetAddr,
    amt: amt.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
  })
}

/**
 * Prepares and sends an unwrap order to transfer WBTC from the smart wallet back to Bitcoin. The function retrieves the necessary swap information and connected wallet details, generates the required signatures for the unwrap order, and constructs the unwrap order parameters before sending the order to the backend API.
 *
 * @param pkscript The pkscript of the target Bitcoin address where the unwrapped WBTC will be sent.
 * @param amt The amount of WBTC to be unwrapped, represented as a bigint.
 *
 * @returns A promise that resolves to an object containing the amount unwrapped, represented as a bigint.
 */
export async function getUnwrapResult(pkscript: string, amt: bigint): Promise<{ amt: bigint }> {
  const swapInfo = await getSwapInfo()
  saveInfo(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: getSwapBalanceOf,
    reservesOf: getPairReserves,
  }

  const btcFee = await requestMinerFee('unwrap')
  const result = await unwrapRequest(
    proxy,
    pubkey,
    pkscript,
    amt,
    '', // bls_signature
    0n, // nonce
    btcFee,
  )

  if (!result.success) {
    if (result.error_message) {
      throw new Error(`${result.error_message}`)
    }
    throw new Error('Failed to create unwrap request.')
  }
  if (!result.data) {
    throw new Error('No data returned from unwrap request.')
  }

  return { amt: result.data.amt }
}

interface UnwrapOrderSignatureRequest {
  pkscript: string
  amt: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
}
async function getUnwrapOrderSignature(orderParams: UnwrapOrderSignatureRequest): Promise<string> {
  orderParams.pkscript = orderParams.pkscript.toLowerCase()

  const signatureText = `Unwrap Order:
Pkscript: ${orderParams.pkscript}
Amount: ${orderParams.amt}
Token 1 Fee Bps: ${orderParams.token1FeeBps}
Token 2 Fee Bps: ${orderParams.token2FeeBps}
BTC Fee: ${orderParams.btc_fee}

By signing this message, you authorize the creation of a withdraw order with the above parameters.`

  const signature = await signMessageLocalVerify(signatureText, 'ordinals')
  return signature
}

interface UnwrapBLSSignatureRequest {
  pubkey: string
  nonce: bigint
  pkscript: string
  amt: bigint
  btc_fee: bigint
}
async function getUnwrapBLSSignature(params: UnwrapBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

  let msg = ethers.keccak256(Buffer.from(params.pubkey, 'hex')).slice(2)
  msg += params.nonce.toString(16).padStart(8, '0')
  msg += '06' // unwrap
  msg += ethers.keccak256(Buffer.from(params.pkscript, 'hex')).slice(2)
  msg += params.amt.toString(16).padStart(64, '0')
  msg += params.btc_fee.toString(16).padStart(64, '0')

  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const blsPrivateKey = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const blsPrivateKeyBuffer = Buffer.from(blsPrivateKey, 'hex')

  const blsSignature = bls12_381.shortSignatures.sign(P, blsPrivateKeyBuffer)

  return `0x${blsSignature.x.toString(16).padStart(128, '0')}${blsSignature.y.toString(16).padStart(128, '0')}`
}

interface UnwrapOrderRequest {
  pubkey: string
  pkscript: string
  amt: string
  bls_signature: string
  token1FeeBps: string
  token2FeeBps: string
  btc_fee: string
  bip322_signature: string
}
interface UnwrapOrderResponse {
  success: boolean
}
async function sendUnwrapOrder(toSend: UnwrapOrderRequest): Promise<UnwrapOrderResponse> {
  const url = getSwapBackendUrl('unwrap')

  return fetchWithErrors<UnwrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toSend),
  })
}

/**
 * Prepares and sends an unwrap order to transfer WBTC from the smart wallet back to Bitcoin. The function retrieves the necessary swap information and connected wallet details, generates the required signatures for the unwrap order, and constructs the unwrap order parameters before sending the order to the backend API.
 *
 * @param pkscript The pkscript of the target Bitcoin address where the unwrapped WBTC will be sent.
 * @param amt The amount of WBTC to be unwrapped, represented as a bigint.
 *
 * @returns A promise that resolves to an object indicating the success of the unwrap order request.
 */
export async function prepareAndSendUnwrapOrder(
  pkscript: string,
  amt: bigint,
): Promise<UnwrapOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const token1FeeBPS = 0n
  const token2FeeBPS = 0n

  const nonce = await getSwapWalletNonce()

  const btcFee = await requestMinerFee('unwrap')
  const bip322Signature = await getUnwrapOrderSignature({
    pkscript,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
  })

  const blsSignature = await getUnwrapBLSSignature({
    pubkey,
    nonce,
    pkscript,
    amt,
    btc_fee: btcFee,
  })

  return await sendUnwrapOrder({
    pubkey,
    pkscript,
    amt: amt.toString(),
    bls_signature: blsSignature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btcFee.toString(),
    bip322_signature: bip322Signature,
  })
}
