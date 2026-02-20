import type { UniswapInfoProxy } from '../lib/uniswap_ops'
import type { SwapWalletInfo } from './store'
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
import {
  add_liquidity_request,
  remove_liquidity_request,
  save_info,
  swap2_request,
  swap_request,
  unwrap_request,
  withdraw_request,
} from '../lib/uniswap_ops'
import { compressSmartContractData } from './brc20'
import { clearExtraUtxos, saveExtraUtxos, utxoOutputTypeFromOutputScript } from './helpers'
import {
  InscriptionDetails,
  mint_all,
  mint_all_check_fees,
  mint_with_extra_input_in_commit_all,
  mint_with_extra_input_in_commit_fee_rate,
  send_inscription_to_op_return_with_extra_inputs_and_extra_output_all,
  send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate,
  WalletInfo,
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
 * @returns {Promise<SwapWalletInfo | null>} Resolves with the SwapWalletInfo if found, or null if no wallet is stored for the current ordinals address.
 */
export async function getSwapWalletFromDB(): Promise<SwapWalletInfo | null> {
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
 * @returns {Promise<SwapWalletInfo>} Resolves with the generated SwapWalletInfo containing the Bitcoin address, BLS public key, and BLS private key.
 */
export async function generateAndStoreSwapWallet(): Promise<SwapWalletInfo> {
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
  const swapWalletInfo: SwapWalletInfo = {
    bitcoinAddress: userOrdinalsWallet.address,
    swapPubkey: blsPubKeyHex,
    swapPrivkey: blsPrivKeyHex,
  }

  // Store in IndexedDB
  await saveSwapWalletInfo(swapWalletInfo)
  return swapWalletInfo
}

interface CheckSwapStatusResponse {
  reorg_handler_running: boolean
  emergency_stop: boolean
}
/**
 * Checks the status of the swap backend, including whether the reorg handler is running and if emergency stop is active.
 *
 * This function is useful for the frontend to determine if the swap functionalities are currently operational or if there are any issues with the backend that users should be aware of.
 *
 * @returns {Promise<CheckSwapStatusResponse>} An object containing the status of the reorg handler and emergency stop.
 */
export async function checkSwapStatus(): Promise<CheckSwapStatusResponse> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('status')

  // The helper handles the fetch and error checking.
  // We expect the API to return a string or number that can be converted to BigInt.
  const result = await fetchWithErrors<CheckSwapStatusResponse>(url, {
    method: 'GET',
  })

  // 3. Convert the result to a BigInt
  return result
}

interface CheckSwapAllowanceResponse {
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
export async function checkSwapAllowance(tokenAddress: string): Promise<bigint> {
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
  const result = await fetchWithErrors<CheckSwapAllowanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

interface SwapInfo {
  factory_address: string
  wbtc_address: string
  wbtc_handler_address: string
}
interface SwapInfoResponse {
  success: boolean
  result: SwapInfo
}
let swapInfoCache: SwapInfo | null = null
async function getSwapInfo(): Promise<SwapInfo> {
  if (swapInfoCache) {
    return swapInfoCache
  }

  // Prepare and execute the API call
  const url = getSwapBackendUrl('get_swap_info')

  // The helper handles the fetch and error checking.
  // We expect the API to return a string or number that can be converted to BigInt.
  const result = await fetchWithErrors<SwapInfoResponse>(url, {
    method: 'GET',
  })

  // Convert the result to SwapInfo
  swapInfoCache = {
    factory_address: result.result.factory_address.toLowerCase(),
    wbtc_address: result.result.wbtc_address.toLowerCase(),
    wbtc_handler_address: result.result.wbtc_handler_address,
  }
  return swapInfoCache
}

interface CheckBRC20BalanceResponse {
  success: boolean
  result: string
}

/**
 * Checks the BRC-20 token balance for the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the BRC-20 token balance for the current ordinals wallet address. The balance is returned as a string from the API and converted to bigint in this function.
 */
export async function checkBRC20ProgBalance(tokenAddress: string): Promise<bigint> {
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

  const result = await fetchWithErrors<CheckBRC20BalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

export interface BaseBRC20Balance {
  available_balance_in_18_dec: bigint
  transferrable_balance_in_18_dec: bigint
  decimals: number
  ticker: string
}

interface CheckBaseBRC20BalanceResponse {
  success: boolean
  result: BaseBRC20Balance
}

/**
 * Checks the base BRC-20 token balance for a given Bitcoin address and token address by making an API call to the swap backend.
 *
 * @param btcAddress The Bitcoin address to check the BRC-20 balance for.
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 *
 * @returns {Promise<BaseBRC20Balance>} A promise that resolves to an object containing the available balance, transferrable balance, decimals, and ticker for the specified Bitcoin address and BRC-20 token address. The balances are returned as strings from the API and converted to bigint in this function.
 */
export async function checkBaseBRC20BalanceOfAddress(
  btcAddress: string,
  tokenAddress: string,
): Promise<BaseBRC20Balance> {
  const url = getSwapBackendUrl('check_base_brc20_balance')
  const body = {
    ordinal_address: btcAddress,
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<CheckBaseBRC20BalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return {
    available_balance_in_18_dec: BigInt(result.result.available_balance_in_18_dec),
    transferrable_balance_in_18_dec: BigInt(result.result.transferrable_balance_in_18_dec),
    decimals: result.result.decimals,
    ticker: result.result.ticker,
  }
}

/**
 * Checks the base BRC-20 token balance for the current ordinals wallet address and a given token address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 * @returns {Promise<BaseBRC20Balance>} A promise that resolves to an object containing the available balance, transferrable balance, decimals, and ticker for the current ordinals wallet address and specified BRC-20 token address. The balances are returned as strings from the API and converted to bigint in this function.
 */
export async function checkBaseBRC20Balance(tokenAddress: string): Promise<BaseBRC20Balance> {
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

  const result = await fetchWithErrors<CheckBaseBRC20BalanceResponse>(url, {
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

/**
 * Checks the BRC-20 token balance for the payment wallet address and a given token address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the BRC-20 token balance for the payment wallet address and specified token address. The balance is returned as a string from the API and converted to bigint in this function.
 */
export async function checkBRC20ProgBalanceOfPaymentWallet(tokenAddress: string): Promise<bigint> {
  // 1. Validate Wallet
  const userPaymentWallet = getPaymentWallet()
  if (!userPaymentWallet?.address) {
    throw new Error('Payment wallet address not found.')
  }

  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('check_brc20_balance')
  const body = {
    ordinal_address: userPaymentWallet.address,
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<CheckBRC20BalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

export interface CheckSwapBalancesItem {
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
  result: CheckSwapBalancesItem[]
}

/**
 * Checks the swap balances for all tokens associated with the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param ordinalsAddress The ordinals wallet address to check the swap balances for.
 * @returns {Promise<CheckSwapBalancesItem[]>} A promise that resolves to an array of CheckSwapBalancesItem objects, each containing details about the token address, balance, ticker, decimals, whether it's an LP token, price in sats, and optionally reserve amounts and decimals for LP tokens. The balances are returned as strings from the API and can be converted to bigint if needed.
 */
export async function checkSwapBalances(ordinalsAddress: string): Promise<CheckSwapBalancesItem[]> {
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

interface CheckSwapBalanceResponse {
  success: boolean
  result: string
}
/**
 * Checks the swap balance for a specific token address associated with the current ordinals wallet address by making an API call to the swap backend.
 *
 * @param tokenAddress The address of the token to check the swap balance for.
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the swap balance for the specified token address and current ordinals wallet address. The balance is returned as a string from the API and converted to bigint in this function.
 */
export async function checkSwapBalance(tokenAddress: string): Promise<bigint> {
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

  const result = await fetchWithErrors<CheckSwapBalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}
async function checkSwapBalanceOf(pubkey: string, tokenAddress: string): Promise<bigint> {
  // 2. Prepare and execute the API call
  const url = getSwapBackendUrl('get_balance')
  const body = {
    pubkey,
    token_addr: tokenAddress,
  }

  const result = await fetchWithErrors<CheckSwapBalanceResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

interface PairReserves {
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
export async function checkPairReserves(pairAddress: string): Promise<PairReserves> {
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

interface GetPairVolumeRequest {
  pair_address: string
  days: number
}
interface GetPairVolumeResponse {
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

interface GetKlinesRequest {
  pair_address: string
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  limit: number // max 1000
  startTime: number | null
  endTime: number | null
}
interface Kline {
  open_time: number
  close_time: number
  open: number
  high: number
  low: number
  close: number
  volume_wbtc: string
  trades: number
}
interface GetKlinesResponse {
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
  const currentTokenAmount = await checkBRC20ProgBalance(tokenAddress)
  if (currentTokenAmount < tokenAmount) {
    const currentBaseAvailableTokenInfo = await checkBaseBRC20Balance(tokenAddress)
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

  const currentAllowance = await checkSwapAllowance(tokenAddress)
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

    baseDepositMintRes = await mint_all(
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
    let send_to_opreturn_res = null
    try {
      if (!baseDepositCommitTxHex) {
        throw new Error('Base deposit commit tx hex is missing')
      }
      saveExtraUtxos(
        [baseDepositCommitTxHex, baseDepositRevealTxHex],
        [baseDepositInscriptionId, satpoint],
      )

      const target_wallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extra_outputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      send_to_opreturn_res
        = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_all(
          baseDepositInscriptionId,
          [],
          target_wallet,
          1,
          extra_outputs,
          feeRate,
          true,
          signFn,
        )
    }
    finally {
      clearExtraUtxos()
    }

    if (send_to_opreturn_res == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    baseDepositSendToOpReturnTxHex = send_to_opreturn_res.signed_tx_hex
    baseDepositSendToOpReturnTxId = send_to_opreturn_res.txid
  }

  let allowance_inscription_id: string | null = null
  let allowance_secret: string | null = null
  let allowance_commit_txid: string | null = null
  let allowance_reveal_txid: string | null = null
  let allowance_commit_tx_hex: string | null = null
  let allowance_reveal_tx_hex: string | null = null
  let allowance_send_to_op_return_tx_hex: string | null = null
  let allowance_send_to_op_return_txid: string | null = null
  let allowance_mint_res = null
  if (needsAllowance) {
    const extra_txhexes_for_allowance = []
    if (useBaseAvailableBalanceAmount > 0n) {
      extra_txhexes_for_allowance.push(
        baseDepositCommitTxHex!,
        baseDepositRevealTxHex!,
        baseDepositSendToOpReturnTxHex!,
      )
    }
    try {
      saveExtraUtxos(extra_txhexes_for_allowance, null)
      allowance_mint_res = await mint_all(
        allowanceInscriptionDetails,
        feeRate,
        null,
        null,
        0,
        true,
        signFn,
      )
      allowance_commit_tx_hex = allowance_mint_res.signed_commit_tx_hex
      allowance_reveal_tx_hex = allowance_mint_res.signed_reveal_tx_hex
      allowance_commit_txid = allowance_mint_res.commit_txid
      allowance_reveal_txid = allowance_mint_res.reveal_txid
      allowance_inscription_id = allowance_mint_res.inscription_id
      allowance_secret = allowance_mint_res.secret
    }
    finally {
      clearExtraUtxos()
    }

    const satpoint = `${allowance_inscription_id.split('i')[0]}:0:0`
    let send_to_opreturn_res = null
    try {
      if (!allowance_commit_tx_hex) {
        throw new Error('Allowance commit tx hex is missing')
      }
      extra_txhexes_for_allowance.push(allowance_commit_tx_hex, allowance_reveal_tx_hex)
      saveExtraUtxos(extra_txhexes_for_allowance, [allowance_inscription_id, satpoint])

      const target_wallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extra_outputs = [
        {
          wallet: payerWallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      send_to_opreturn_res
        = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_all(
          allowance_inscription_id,
          [],
          target_wallet,
          1,
          extra_outputs,
          feeRate,
          true,
          signFn,
        )
    }
    finally {
      clearExtraUtxos()
    }

    if (send_to_opreturn_res == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    allowance_send_to_op_return_tx_hex = send_to_opreturn_res.signed_tx_hex
    allowance_send_to_op_return_txid = send_to_opreturn_res.txid
  }

  const extra_utxos = []
  const extra_tx_hexes = []
  if (useBaseAvailableBalanceAmount > 0n) {
    if (
      !baseDepositCommitTxHex
      || !baseDepositRevealTxHex
      || !baseDepositSendToOpReturnTxHex
    ) {
      throw new Error('Base deposit transaction hexes are missing')
    }
    extra_tx_hexes.push(
      baseDepositCommitTxHex,
      baseDepositRevealTxHex,
      baseDepositSendToOpReturnTxHex,
    )

    extra_utxos.push({
      utxo: `${baseDepositSendToOpReturnTxId}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }
  if (needsAllowance) {
    if (
      !allowance_commit_tx_hex
      || !allowance_reveal_tx_hex
      || !allowance_send_to_op_return_tx_hex
    ) {
      throw new Error('Allowance transaction hexes are missing')
    }
    extra_tx_hexes.push(
      allowance_commit_tx_hex,
      allowance_reveal_tx_hex,
      allowance_send_to_op_return_tx_hex,
    )

    extra_utxos.push({
      utxo: `${allowance_send_to_op_return_txid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payerWallet.outputScript, network),
      wallet: payerWallet,
    })
  }

  let send_to_opreturn_res = null
  let deposit_mint_res = null
  let deposit_inscription_id: string = ''
  let deposit_secret: string = ''
  let deposit_commit_tx_hex: string = ''
  let deposit_reveal_tx_hex: string = ''
  try {
    if (extra_tx_hexes.length > 0) {
      saveExtraUtxos(extra_tx_hexes, null)
    }
    deposit_mint_res = await mint_with_extra_input_in_commit_all(
      depositInscriptionDetails,
      extra_utxos,
      feeRate,
      null,
      null,
      0,
      true,
      signFn,
    )
    deposit_commit_tx_hex = deposit_mint_res.signed_commit_tx_hex
    deposit_reveal_tx_hex = deposit_mint_res.signed_reveal_tx_hex
    deposit_inscription_id = deposit_mint_res.inscription_id
    const deposit_satpoint = `${deposit_inscription_id.split('i')[0]}:0:0`
    deposit_secret = deposit_mint_res.secret
    extra_tx_hexes.push(deposit_commit_tx_hex!, deposit_reveal_tx_hex!)
    saveExtraUtxos(extra_tx_hexes, [deposit_inscription_id, deposit_satpoint])
    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_to_opreturn_res
      = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_all(
        deposit_inscription_id,
        [],
        target_wallet,
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

  if (send_to_opreturn_res == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  const deposit_send_to_op_return_tx_hex = send_to_opreturn_res.signed_tx_hex
  const deposit_send_to_op_return_txid = send_to_opreturn_res.txid

  const to_send_for_broadcast: BroadcastDepositOrderRequest = {
    commit_txid: deposit_mint_res.commit_txid,
    commit_txhex: deposit_commit_tx_hex,
    reveal_txid: deposit_mint_res.reveal_txid,
    reveal_txhex: deposit_reveal_tx_hex,
    send_to_opreturn_txid: deposit_send_to_op_return_txid,
    send_to_opreturn_txhex: deposit_send_to_op_return_tx_hex,
    secret: deposit_secret,
    inscription_id: deposit_inscription_id,
    fee_rate: feeRate,

    approve_details: needsAllowance
      ? {
          commit_txid: allowance_commit_txid!,
          commit_txhex: allowance_commit_tx_hex!,
          reveal_txid: allowance_reveal_txid!,
          reveal_txhex: allowance_reveal_tx_hex!,
          send_to_opreturn_txid: allowance_send_to_op_return_txid!,
          send_to_opreturn_txhex: allowance_send_to_op_return_tx_hex!,
          secret: allowance_secret!,
          inscription_id: allowance_inscription_id!,
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
  const broadcast_res = await broadcastDepositOrder(to_send_for_broadcast)

  return broadcast_res.result
}

/**
 *
 * @param token_address
 * @param token_amount
 * @param fee_rate
 * @param create_allowance_if_needed
 */
export async function checkMinerFeesOfDepositOrder(
  token_address: string,
  token_amount: bigint,
  fee_rate: number,
  create_allowance_if_needed: boolean = true,
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

  const payer_addr = userPaymentWallet.address
  const payer_public_key = userPaymentWallet.pubkey

  const payer_wallet = new WalletInfo(false, null, payer_addr, null, payer_public_key)

  let use_base_available_balance_amt = 0n
  let base_token_decimals = 0
  let base_token_ticker = ''
  const current_token_amount = await checkBRC20ProgBalance(token_address)
  if (current_token_amount < token_amount) {
    const current_base_available_token_info = await checkBaseBRC20Balance(token_address)
    const current_base_available_token_amount
      = current_base_available_token_info.available_balance_in_18_dec
    base_token_decimals = current_base_available_token_info.decimals
    base_token_ticker = current_base_available_token_info.ticker
    use_base_available_balance_amt = token_amount - current_token_amount
    if (current_base_available_token_amount < use_base_available_balance_amt) {
      console.error(
        `Insufficient BRC-2.0 + BRC20 available balance. Current BRC-2.0: ${current_token_amount}, Available in base: ${current_base_available_token_amount}, Required: ${token_amount}`,
      )
      throw new Error('Insufficient BRC-2.0 + BRC20 available balance')
    }
  }

  const current_allowance = await checkSwapAllowance(token_address)
  let needs_allowance = false
  if (
    current_allowance < BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  ) {
    if (!create_allowance_if_needed) {
      console.error('Insufficient allowance for BRC-2.0 token transfer.')
      throw new Error('Insufficient allowance for BRC-2.0 token transfer.')
    }
    needs_allowance = true
  }

  const l1_contract_address = getSwapContractAddress()
  const allowance_calldata = `0x095ea7b3000000000000000000000000${l1_contract_address.slice(2).toLowerCase()}ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`
  const allowance_calldata_compressed = await compressSmartContractData(allowance_calldata)
  const allowance_content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${token_address}","b":"${allowance_calldata_compressed}"}`,
  )
  const allowance_inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    allowance_content,
  )

  const swap_pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swap_pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ec_signature = `0x${'00'.repeat(64)}` // dummy
  const pubkey_idx = 1 // dummy
  const token_idx = 1 // dummy

  const neg_signature_bls12 = await getDepositBLSSignature({
    pubkey: swap_pubkey,
    pk_idx: BigInt(pubkey_idx),
  })

  const l1_swap = getSwapContractInterface()
  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const deposit_calldata = l1_swap.encodeFunctionData('deposit', [
    token_address,
    token_idx,
    token_amount,
    swap_pubkey,
    BigInt(pubkey_idx),
    neg_signature_bls12,
    ec_signature,
  ])
  const deposit_calldata_compressed = await compressSmartContractData(deposit_calldata)
  const deposit_content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${l1_contract_address}","b":"${deposit_calldata_compressed}"}`,
  )
  const deposit_inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    deposit_content,
  )

  let base_deposit_inscription_id = null
  let base_deposit_commit_tx_hex = null
  let base_deposit_reveal_tx_hex = null
  let base_deposit_send_to_op_return_tx_hex = null
  let base_deposit_send_to_op_return_txid = null
  let base_deposit_fees_total = 0
  if (use_base_available_balance_amt > 0n) {
    const amount_to_deposit = convertAmountToBRC20String(
      use_base_available_balance_amt,
      base_token_decimals,
    )
    const base_deposit_inscription_details = new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      Buff.str(
        `{"p":"brc-20","op":"transfer","tick":"${base_token_ticker}","amt":"${amount_to_deposit}"}`,
      ),
    )

    const base_deposit_mint_res = await mint_all_check_fees(
      base_deposit_inscription_details,
      fee_rate,
      null,
      null,
      0,
    )
    base_deposit_commit_tx_hex = base_deposit_mint_res.unsigned_commit_tx_hex
    base_deposit_reveal_tx_hex = base_deposit_mint_res.signed_reveal_tx_hex
    base_deposit_inscription_id = base_deposit_mint_res.inscription_id
    base_deposit_fees_total += base_deposit_mint_res.total_fee
    const satpoint = `${base_deposit_inscription_id.split('i')[0]}:0:0`
    let send_to_opreturn_res = null
    try {
      if (!base_deposit_commit_tx_hex) {
        throw new Error('Base deposit commit tx hex is missing')
      }
      saveExtraUtxos(
        [base_deposit_commit_tx_hex, base_deposit_reveal_tx_hex],
        [base_deposit_inscription_id, satpoint],
      )

      const target_wallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extra_outputs = [
        {
          wallet: payer_wallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      send_to_opreturn_res
        = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate(
          base_deposit_inscription_id,
          [],
          target_wallet,
          1,
          extra_outputs,
          fee_rate,
        )
    }
    finally {
      clearExtraUtxos()
    }

    if (send_to_opreturn_res == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    base_deposit_send_to_op_return_tx_hex = send_to_opreturn_res.unsigned_tx_hex
    base_deposit_send_to_op_return_txid = send_to_opreturn_res.txid
    base_deposit_fees_total += send_to_opreturn_res.tx_fee
  }

  let allowance_inscription_id = null
  let allowance_commit_tx_hex = null
  let allowance_reveal_tx_hex = null
  let allowance_send_to_op_return_tx_hex = null
  let allowance_send_to_op_return_txid = null
  let allowance_fees_total = 0
  if (needs_allowance) {
    const extra_txhexes_for_allowance = []
    if (use_base_available_balance_amt > 0n) {
      extra_txhexes_for_allowance.push(
        base_deposit_commit_tx_hex!,
        base_deposit_reveal_tx_hex!,
        base_deposit_send_to_op_return_tx_hex!,
      )
    }
    try {
      saveExtraUtxos(extra_txhexes_for_allowance, null)
      const allowance_mint_res = await mint_all_check_fees(
        allowance_inscription_details,
        fee_rate,
        null,
        null,
        0,
      )
      allowance_commit_tx_hex = allowance_mint_res.unsigned_commit_tx_hex
      allowance_reveal_tx_hex = allowance_mint_res.signed_reveal_tx_hex
      allowance_inscription_id = allowance_mint_res.inscription_id
      allowance_fees_total += allowance_mint_res.total_fee
    }
    finally {
      clearExtraUtxos()
    }

    const satpoint = `${allowance_inscription_id.split('i')[0]}:0:0`
    let send_to_opreturn_res = null
    try {
      if (!allowance_commit_tx_hex) {
        throw new Error('Allowance commit tx hex is missing')
      }
      extra_txhexes_for_allowance.push(allowance_commit_tx_hex, allowance_reveal_tx_hex)
      saveExtraUtxos(extra_txhexes_for_allowance, [allowance_inscription_id, satpoint])

      const target_wallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extra_outputs = [
        {
          wallet: payer_wallet,
          value: DUMMY_UTXO_VALUE,
        },
      ]
      send_to_opreturn_res
        = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate(
          allowance_inscription_id,
          [],
          target_wallet,
          1,
          extra_outputs,
          fee_rate,
        )
    }
    finally {
      clearExtraUtxos()
    }

    if (send_to_opreturn_res == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    allowance_send_to_op_return_tx_hex = send_to_opreturn_res.unsigned_tx_hex
    allowance_send_to_op_return_txid = send_to_opreturn_res.txid
    allowance_fees_total += send_to_opreturn_res.tx_fee
  }

  const extra_utxos = []
  const extra_tx_hexes = []
  if (use_base_available_balance_amt > 0n) {
    if (
      !base_deposit_commit_tx_hex
      || !base_deposit_reveal_tx_hex
      || !base_deposit_send_to_op_return_tx_hex
    ) {
      throw new Error('Base deposit transaction hexes are missing')
    }
    extra_tx_hexes.push(
      base_deposit_commit_tx_hex,
      base_deposit_reveal_tx_hex,
      base_deposit_send_to_op_return_tx_hex,
    )

    extra_utxos.push({
      utxo: `${base_deposit_send_to_op_return_txid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payer_wallet.outputScript, network),
      wallet: payer_wallet,
    })
  }
  if (needs_allowance) {
    if (
      !allowance_commit_tx_hex
      || !allowance_reveal_tx_hex
      || !allowance_send_to_op_return_tx_hex
    ) {
      throw new Error('Allowance transaction hexes are missing')
    }
    extra_tx_hexes.push(
      allowance_commit_tx_hex,
      allowance_reveal_tx_hex,
      allowance_send_to_op_return_tx_hex,
    )

    extra_utxos.push({
      utxo: `${allowance_send_to_op_return_txid}:1`,
      value: DUMMY_UTXO_VALUE,
      script_type: utxoOutputTypeFromOutputScript(payer_wallet.outputScript, network),
      wallet: payer_wallet,
    })
  }

  let deposit_fees_total = 0
  let send_to_opreturn_res = null
  try {
    if (extra_tx_hexes.length > 0) {
      saveExtraUtxos(extra_tx_hexes, null)
    }
    const deposit_mint_res = await mint_with_extra_input_in_commit_fee_rate(
      deposit_inscription_details,
      extra_utxos,
      fee_rate,
      null,
      null,
      0,
    )
    const deposit_commit_tx_hex = deposit_mint_res.unsigned_commit_tx_hex
    const deposit_reveal_tx_hex = deposit_mint_res.signed_reveal_tx_hex
    const deposit_inscription_id = deposit_mint_res.inscription_id
    const deposit_satpoint = `${deposit_inscription_id.split('i')[0]}:0:0`
    deposit_fees_total += deposit_mint_res.total_fee
    extra_tx_hexes.push(deposit_commit_tx_hex!, deposit_reveal_tx_hex!)
    saveExtraUtxos(extra_tx_hexes, [deposit_inscription_id, deposit_satpoint])
    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    send_to_opreturn_res
      = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate(
        deposit_inscription_id,
        [],
        target_wallet,
        1,
        [],
        fee_rate,
      )
  }
  finally {
    clearExtraUtxos()
  }

  if (send_to_opreturn_res == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  deposit_fees_total += send_to_opreturn_res.tx_fee

  const to_return = {
    needs_approval: needs_allowance,
    base_deposit_fees_total,
    allowance_fees_total,
    deposit_fees_total,
    fee_rate,
  }
  return to_return
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
  to_send: BroadcastWrapOrderRequest,
): Promise<BroadcastWrapOrderResponse> {
  const url = getSwapBackendUrl('wrap')

  return fetchWithErrors<BroadcastWrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}
interface EstimateGasWrapOrderResponse {
  success: boolean
  estimated_gas: number
  allocated_gas: number
}
async function estimateGasWrapOrder(
  to_send: BroadcastWrapOrderRequest,
): Promise<EstimateGasWrapOrderResponse> {
  const url = getSwapBackendUrl('estimate_wrap_gas')

  return fetchWithErrors<EstimateGasWrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}
/**
 *
 * @param btc_amount
 * @param fee_rate
 */
export async function createAndBroadcastWrapOrder(
  btc_amount: bigint,
  fee_rate: number,
): Promise<string[]> {
  const swap_info = await getSwapInfo()
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

  const ordinals_addr = userOrdinalsWallet.address

  const l1_contract_address = getSwapContractAddress()

  const swap_pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swap_pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const bip322_signature = await getDepositBIP322Signature({
    btc_address: ordinals_addr,
    bls_pubkey: swap_pubkey,
    token_address: swap_info.wbtc_address,
  })

  const ordinals_script = bitcoinjs.address.toOutputScript(ordinals_addr, getBitcoinNetwork())
  const neg_signature_bls12_emergency = await getEmergencyBLSSignature({
    pubkey: swap_pubkey,
    ordinals_script: ordinals_script.toString('hex'),
  })
  const deposit_details = await getDepositSignature({
    btc_address: ordinals_addr,
    bls_pubkey: swap_pubkey,
    token_address: swap_info.wbtc_address.toLowerCase(),
    bip322_signature,
    bls12_signature: neg_signature_bls12_emergency,
  })
  const ec_signature = deposit_details.edcsa_signature
  const pubkey_idx = deposit_details.pubkey_idx
  const token_idx = deposit_details.token_idx

  const neg_signature_bls12 = await getDepositBLSSignature({
    pubkey: swap_pubkey,
    pk_idx: BigInt(pubkey_idx),
  })

  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const call_data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint32', 'bytes', 'uint64', 'bytes', 'bytes'],
    [
      swap_info.wbtc_address,
      token_idx,
      Buffer.from(swap_pubkey.slice(2), 'hex'),
      pubkey_idx,
      Buffer.from(neg_signature_bls12.slice(2), 'hex'),
      Buffer.from(ec_signature.slice(2), 'hex'),
    ],
  )
  const wrap_call_data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [l1_contract_address, Buffer.from(call_data.slice(2), 'hex')],
  )
  const wrap_call_data_full = `0x5608f857${wrap_call_data.slice(2)}`

  const deposit_calldata_compressed = await compressSmartContractData(wrap_call_data_full)
  const deposit_content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${swap_info.wbtc_address}","b":"${deposit_calldata_compressed}"}`,
  )
  let estimated_gas = 0
  for (let i = 0; i < 5; i++) {
    const deposit_content_gas_allocation = deposit_content.length * GAS_PER_BYTE
    const needed_padding
      = estimated_gas > deposit_content_gas_allocation
        ? Math.ceil((estimated_gas - deposit_content_gas_allocation) / GAS_PER_BYTE)
        : 0
    const padded_deposit_content = Buff.from(
      Buffer.concat([deposit_content, Buff.str(' '.repeat(needed_padding))]),
    )
    const deposit_inscription_details = new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      padded_deposit_content,
    )

    const deposit_mint_res = await mint_with_extra_input_in_commit_all(
      deposit_inscription_details,
      [],
      fee_rate,
      null,
      null,
      0,
      true,
      signFn,
    )
    const deposit_commit_tx_hex = deposit_mint_res.signed_commit_tx_hex
    const deposit_reveal_tx_hex = deposit_mint_res.signed_reveal_tx_hex
    const deposit_inscription_id = deposit_mint_res.inscription_id
    const deposit_satpoint = `${deposit_inscription_id.split('i')[0]}:0:0`
    const deposit_secret = deposit_mint_res.secret
    let send_to_opreturn_res = null
    try {
      saveExtraUtxos(
        [deposit_commit_tx_hex, deposit_reveal_tx_hex],
        [deposit_inscription_id, deposit_satpoint],
      )

      const target_wallet = new WalletInfo(
        true,
        Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
        null,
        null,
        null,
      )
      const extra_output_utxos = [
        // send BTC to WBTC handler
        {
          wallet: new WalletInfo(false, null, swap_info.wbtc_handler_address, null, null),
          value: Number.parseInt(btc_amount.toString()),
        },
      ]
      send_to_opreturn_res
        = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_all(
          deposit_inscription_id,
          [],
          target_wallet,
          1,
          extra_output_utxos,
          fee_rate,
          true,
          signFn,
        )
    }
    finally {
      clearExtraUtxos()
    }

    if (send_to_opreturn_res == null) {
      throw new Error('Failed to send inscription to OP_RETURN')
    }

    const deposit_send_to_op_return_tx_hex = send_to_opreturn_res.signed_tx_hex
    const deposit_send_to_op_return_txid = send_to_opreturn_res.txid

    const to_send_for_broadcast: BroadcastWrapOrderRequest = {
      commit_txid: deposit_mint_res.commit_txid,
      commit_txhex: deposit_commit_tx_hex,
      reveal_txid: deposit_mint_res.reveal_txid,
      reveal_txhex: deposit_reveal_tx_hex,
      send_to_opreturn_txid: deposit_send_to_op_return_txid,
      send_to_opreturn_txhex: deposit_send_to_op_return_tx_hex,
      secret: deposit_secret,
      inscription_id: deposit_inscription_id,
      fee_rate,
    }
    const estimate_gas_res = await estimateGasWrapOrder(to_send_for_broadcast)
    const estimate_padded = Math.max(
      estimate_gas_res.estimated_gas + 100000,
      estimate_gas_res.estimated_gas * 1.2,
    )
    if (estimate_gas_res.allocated_gas < estimate_padded) {
      estimated_gas = estimate_padded + 50000
      continue
    }
    const broadcast_res = await broadcastWrapOrder(to_send_for_broadcast)

    return broadcast_res.result
  }

  throw new Error('Failed to estimate gas for wrap order after multiple attempts')
}

/**
 *
 * @param btcAmount
 * @param feeRate
 */
export async function checkMinerFeesOfWrapOrder(
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

  const L1ContractAddress = getSwapContractAddress()

  const swapPubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!swapPubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ec_signature = `0x${'00'.repeat(64)}` // dummy
  const pubkey_idx = 1 // dummy
  const token_idx = 1 // dummy

  const neg_signature_bls12 = await getDepositBLSSignature({
    pubkey: swapPubkey,
    pk_idx: BigInt(pubkey_idx),
  })

  // tokenAddress, tickerIdx, amt, pubkey, pkIdx, negSignatureBLS12, ecSignatureForIndexes
  const call_data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint32', 'bytes', 'uint64', 'bytes', 'bytes'],
    [
      swapInfo.wbtc_address,
      token_idx,
      Buffer.from(swapPubkey.slice(2), 'hex'),
      pubkey_idx,
      Buffer.from(neg_signature_bls12.slice(2), 'hex'),
      Buffer.from(ec_signature.slice(2), 'hex'),
    ],
  )
  const wrap_call_data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [L1ContractAddress, Buffer.from(call_data.slice(2), 'hex')],
  )
  const wrap_call_data_full = `0x5608f857${wrap_call_data.slice(2)}`

  const deposit_calldata_compressed = await compressSmartContractData(wrap_call_data_full)
  const deposit_content = Buff.str(
    `{"p":"brc20-prog","op":"c","c":"${swapInfo.wbtc_address}","b":"${deposit_calldata_compressed}"}`,
  )
  const deposit_inscription_details = new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    deposit_content,
  )

  let deposit_fees_total = 0
  const deposit_mint_res = await mint_with_extra_input_in_commit_fee_rate(
    deposit_inscription_details,
    [],
    feeRate,
    null,
    null,
    0,
  )
  const deposit_commit_tx_hex = deposit_mint_res.unsigned_commit_tx_hex
  const deposit_reveal_tx_hex = deposit_mint_res.signed_reveal_tx_hex
  const deposit_inscription_id = deposit_mint_res.inscription_id
  const deposit_satpoint = `${deposit_inscription_id.split('i')[0]}:0:0`
  deposit_fees_total += deposit_mint_res.total_fee
  let send_to_opreturn_res = null
  try {
    saveExtraUtxos(
      [deposit_commit_tx_hex, deposit_reveal_tx_hex],
      [deposit_inscription_id, deposit_satpoint],
    )

    const target_wallet = new WalletInfo(
      true,
      Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
      null,
      null,
      null,
    )
    const extra_output_utxos = [
      // send BTC to WBTC handler
      {
        wallet: new WalletInfo(false, null, swapInfo.wbtc_handler_address, null, null),
        value: Number.parseInt(btcAmount.toString()),
      },
    ]
    send_to_opreturn_res
      = await send_inscription_to_op_return_with_extra_inputs_and_extra_output_fee_rate(
        deposit_inscription_id,
        [],
        target_wallet,
        1,
        extra_output_utxos,
        feeRate,
      )
  }
  finally {
    clearExtraUtxos()
  }

  if (send_to_opreturn_res == null) {
    throw new Error('Failed to send inscription to OP_RETURN')
  }

  deposit_fees_total += send_to_opreturn_res.tx_fee

  const to_return = {
    total_fee: deposit_fees_total,
    fee_rate: feeRate,
  }
  return to_return
}

/**
 *
 * @param token1Addr
 * @param token2Addr
 * @param amt1
 * @param amt2
 */
export async function getAddLiquidityResult(
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
): Promise<{ amountA: bigint, amountB: bigint, liquidity: bigint }> {
  const swapInfo = await getSwapInfo()
  save_info(swapInfo.wbtc_address, swapInfo.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btcFee = await requestMinerFee('add_liquidity')

  const result = await add_liquidity_request(
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
  order_params: AddLiquiditySignatureRequest,
): Promise<string> {
  order_params.token1_addr = order_params.token1_addr.toLowerCase()
  order_params.token2_addr = order_params.token2_addr.toLowerCase()

  const signature_text = `Add Liquidity Order:
Token 1 Address: ${order_params.token1_addr}
Token 2 Address: ${order_params.token2_addr}
Amount 1: ${order_params.amt1}
Amount 2: ${order_params.amt2}
Minimum Amount 1: ${order_params.minamt1}
Minimum Amount 2: ${order_params.minamt2}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of an add liquidity order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
  to_send: AddLiquidityOrderRequest,
): Promise<AddLiquidityOrderResponse> {
  const url = getSwapBackendUrl('add_liq_req')

  return fetchWithErrors<AddLiquidityOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param token1_addr
 * @param token2_addr
 * @param amt1
 * @param amt2
 * @param slippageBPS
 */
export async function prepareAndSendAddLiquidityOrder(
  token1_addr: string,
  token2_addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<AddLiquidityOrderResponse> {
  const swap_info = await getSwapInfo()

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const minamt1 = (amt1 * (10000n - slippageBPS)) / 10000n
  const minamt2 = (amt2 * (10000n - slippageBPS)) / 10000n
  const token1FeeBPS = 0n
  const token2FeeBPS = 0n
  if (
    token1_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
    && token2_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('add_liquidity')
  const bip322_signature = await getAddLiquiditySignature({
    token1_addr,
    token2_addr,
    amt1: amt1.toString(),
    amt2: amt2.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getAddLiquidityBLSSignature({
    pubkey,
    nonce,
    token1_addr,
    token2_addr,
    amt1,
    amt2,
    minamt1,
    minamt2,
    token1FeeBps: token1FeeBPS,
    token2FeeBps: token2FeeBPS,
    btc_fee,
  })

  return await sendAddLiquidityOrder({
    pubkey,
    token1_addr,
    token2_addr,
    amt1: amt1.toString(),
    amt2: amt2.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    bls_signature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

/**
 *
 * @param token1_addr
 * @param token2_addr
 * @param lp_amt
 */
export async function getRemoveLiquidityResult(
  token1_addr: string,
  token2_addr: string,
  lp_amt: bigint,
): Promise<{ amountA: bigint, amountB: bigint, liquidity: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('remove_liquidity')
  const result = await remove_liquidity_request(
    proxy,
    pubkey,
    token1_addr,
    token2_addr,
    lp_amt,
    0n, // minamt1
    0n, // minamt2
    '', // bls_signature
    0n, // nonce
    0n, // token1FeeBps
    0n, // token2FeeBps
    btc_fee, // btc_fee
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
  order_params: RemoveLiquiditySignatureRequest,
): Promise<string> {
  order_params.token1_addr = order_params.token1_addr.toLowerCase()
  order_params.token2_addr = order_params.token2_addr.toLowerCase()

  const signature_text = `Remove Liquidity Order:
Token 1 Address: ${order_params.token1_addr}
Token 2 Address: ${order_params.token2_addr}
LP Amount: ${order_params.lp_amt}
Minimum Amount 1: ${order_params.minamt1}
Minimum Amount 2: ${order_params.minamt2}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of a remove liquidity order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
  to_send: RemoveLiquidityOrderRequest,
): Promise<RemoveLiquidityOrderResponse> {
  const url = getSwapBackendUrl('remove_liq_req')

  return fetchWithErrors<RemoveLiquidityOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param token1_addr
 * @param token2_addr
 * @param lp_amt
 * @param amt1
 * @param amt2
 * @param slippageBPS
 */
export async function prepareAndSendRemoveLiquidityOrder(
  token1_addr: string,
  token2_addr: string,
  lp_amt: bigint,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<RemoveLiquidityOrderResponse> {
  const swap_info = await getSwapInfo()

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const minamt1 = (amt1 * (10000n - slippageBPS)) / 10000n
  const minamt2 = (amt2 * (10000n - slippageBPS)) / 10000n
  const token1FeeBPS = 0n
  const token2FeeBPS = 0n
  if (
    token1_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
    && token2_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('remove_liquidity')
  const bip322_signature = await getRemoveLiquiditySignature({
    token1_addr,
    token2_addr,
    lp_amt: lp_amt.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getRemoveLiquidityBLSSignature({
    pubkey,
    nonce,
    token1_addr,
    token2_addr,
    lp_amt,
    minamt1,
    minamt2,
    token1FeeBps: token1FeeBPS,
    token2FeeBps: token2FeeBPS,
    btc_fee,
  })

  return await sendRemoveLiquidityOrder({
    pubkey,
    token1_addr,
    token2_addr,
    lp_amt: lp_amt.toString(),
    minamt1: minamt1.toString(),
    minamt2: minamt2.toString(),
    bls_signature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

async function getSwapFeesBps(
  token1_addr: string,
  token2_addr: string,
): Promise<{ token1FeeBps: bigint, token2FeeBps: bigint }> {
  const swap_info = await getSwapInfo()

  let token1FeeBps = 25n
  let token2FeeBps = 0n
  if (
    token1_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
    && token2_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()
  ) {
    throw new Error('One of the tokens must be BTC')
  }
  if (token1_addr.toLowerCase() !== swap_info.wbtc_address.toLowerCase()) {
    token1FeeBps = 0n
    token2FeeBps = 25n
  }

  return { token1FeeBps, token2FeeBps }
}

/**
 *
 * @param token_in_addr
 * @param token_out_addr
 * @param amt_in
 */
export async function getSwapResult(
  token_in_addr: string,
  token_out_addr: string,
  amt_in: bigint,
): Promise<{ amount_out: bigint, quoted_price: number, price_impact_bps: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token_in_addr, token_out_addr)
  const result = await swap_request(
    proxy,
    pubkey,
    token_in_addr,
    token_out_addr,
    amt_in,
    0n, // min_out_amt
    '', // bls_signature
    0n, // nonce
    token1FeeBps,
    token2FeeBps,
    btc_fee,
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

  const decimals_of_in = await getTokenDecimals(token_in_addr)
  const decimals_of_out = await getTokenDecimals(token_out_addr)
  const quoted_price
    = token_in_addr.toLowerCase() === swap_info.wbtc_address.toLowerCase()
      ? (amt_in * 10n ** BigInt(decimals_of_out) * 100n) / result.amounts[1]!
      : (result.amounts[1]! * 10n ** BigInt(decimals_of_in) * 100n) / amt_in
  const quoted_price_number = Number(quoted_price) / 100.0

  return {
    amount_out: result.amounts[1]!,
    quoted_price: quoted_price_number,
    price_impact_bps: result.price_impact_bps,
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
}
async function getSwapOrderSignature(order_params: SwapOrderSignatureRequest): Promise<string> {
  order_params.token1_addr = order_params.token1_addr.toLowerCase()
  order_params.token2_addr = order_params.token2_addr.toLowerCase()

  const signature_text = `Swap Order:
Token 1 Address: ${order_params.token1_addr}
Token 2 Address: ${order_params.token2_addr}
Input Amount: ${order_params.in_amt}
Minimum Output Amount: ${order_params.min_out_amt}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of a swap order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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
}
async function getSwapBLSSignature(params: SwapBLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
}
interface SwapOrderResponse {
  success: boolean
}
async function sendSwapOrder(to_send: SwapOrderRequest): Promise<SwapOrderResponse> {
  const url = getSwapBackendUrl('swap')

  return fetchWithErrors<SwapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param token1_addr
 * @param token2_addr
 * @param amt1
 * @param amt2
 * @param slippageBPS
 */
export async function prepareAndSendSwapOrder(
  token1_addr: string,
  token2_addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<SwapOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const min_out_amt = (amt2 * (10000n - slippageBPS)) / 10000n

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token1_addr, token2_addr)
  const bip322_signature = await getSwapOrderSignature({
    token1_addr,
    token2_addr,
    in_amt: amt1.toString(),
    min_out_amt: min_out_amt.toString(),
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getSwapBLSSignature({
    pubkey,
    nonce,
    token1_addr,
    token2_addr,
    in_amt: amt1,
    min_out_amt,
    token1FeeBps,
    token2FeeBps,
    btc_fee,
  })

  return await sendSwapOrder({
    pubkey,
    token1_addr,
    token2_addr,
    in_amt: amt1.toString(),
    min_out_amt: min_out_amt.toString(),
    bls_signature,
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

/**
 *
 * @param token_in_addr
 * @param token_out_addr
 * @param amt_out
 */
export async function getSwap2Result(
  token_in_addr: string,
  token_out_addr: string,
  amt_out: bigint,
): Promise<{ amount_in: bigint, quoted_price: number, price_impact_bps: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token_in_addr, token_out_addr)
  const result = await swap2_request(
    proxy,
    pubkey,
    token_in_addr,
    token_out_addr,
    BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), // max_in_amt
    amt_out,
    '', // bls_signature
    0n, // nonce
    token1FeeBps,
    token2FeeBps,
    btc_fee,
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

  const decimals_of_in = await getTokenDecimals(token_in_addr)
  const decimals_of_out = await getTokenDecimals(token_out_addr)
  const quoted_price
    = token_in_addr.toLowerCase() === swap_info.wbtc_address.toLowerCase()
      ? (result.amounts[0]! * 10n ** BigInt(decimals_of_out) * 100n) / amt_out
      : (amt_out * 10n ** BigInt(decimals_of_in) * 100n) / result.amounts[0]!

  const quoted_price_number = Number(quoted_price) / 100.0

  return {
    amount_in: result.amounts[0]!,
    quoted_price: quoted_price_number,
    price_impact_bps: result.price_impact_bps,
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
}
async function getSwap2OrderSignature(order_params: Swap2OrderSignatureRequest): Promise<string> {
  order_params.token1_addr = order_params.token1_addr.toLowerCase()
  order_params.token2_addr = order_params.token2_addr.toLowerCase()

  const signature_text = `Swap Order:
Token 1 Address: ${order_params.token1_addr}
Token 2 Address: ${order_params.token2_addr}
Maximum Input Amount: ${order_params.max_in_amt}
Output Amount: ${order_params.out_amt}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of a swap order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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
}
async function getSwap2BLSSignature(params: Swap2BLSSignatureRequest): Promise<string> {
  params.pubkey = params.pubkey.startsWith('0x') ? params.pubkey.slice(2) : params.pubkey

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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
}
interface Swap2OrderResponse {
  success: boolean
}
async function sendSwap2Order(to_send: Swap2OrderRequest): Promise<Swap2OrderResponse> {
  const url = getSwapBackendUrl('swap2')

  return fetchWithErrors<Swap2OrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param token1_addr
 * @param token2_addr
 * @param amt1
 * @param amt2
 * @param slippageBPS
 */
export async function prepareAndSendSwap2Order(
  token1_addr: string,
  token2_addr: string,
  amt1: bigint,
  amt2: bigint,
  slippageBPS: bigint,
): Promise<Swap2OrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const max_in_amt = (amt1 * (10000n + slippageBPS)) / 10000n

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('swap')
  const { token1FeeBps, token2FeeBps } = await getSwapFeesBps(token1_addr, token2_addr)
  const bip322_signature = await getSwap2OrderSignature({
    token1_addr,
    token2_addr,
    max_in_amt: max_in_amt.toString(),
    out_amt: amt2.toString(),
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getSwap2BLSSignature({
    pubkey,
    nonce,
    token1_addr,
    token2_addr,
    max_in_amt,
    out_amt: amt2,
    token1FeeBps,
    token2FeeBps,
    btc_fee,
  })

  return await sendSwap2Order({
    pubkey,
    token1_addr,
    token2_addr,
    max_in_amt: max_in_amt.toString(),
    out_amt: amt2.toString(),
    bls_signature,
    token1FeeBps: token1FeeBps.toString(),
    token2FeeBps: token2FeeBps.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

function btcAddressToEvmAddress(btc_addr: string): string {
  const network = getBitcoinNetwork()
  return `0x${ethers.keccak256(bitcoinjs.address.toOutputScript(btc_addr, network)).slice(26)}`
}

/**
 *
 * @param token_address
 * @param ordinal_address
 * @param amt
 */
export async function getWithdrawWithdrawToOrdinalWalletResult(
  token_address: string,
  ordinal_address: string,
  amt: bigint,
): Promise<{ amt: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const target_btc_addr = ordinal_address
  const target_address = btcAddressToEvmAddress(target_btc_addr)

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('withdraw')
  const result = await withdraw_request(
    proxy,
    pubkey,
    token_address,
    target_address,
    amt,
    '', // bls_signature
    0n, // nonce
    btc_fee,
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
 *
 * @param token_address
 * @param amt
 */
export async function getWithdrawWithdrawToSelfOrdinalWalletResult(
  token_address: string,
  amt: bigint,
): Promise<{ amt: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const ordinalsWallet = getOrdinalsWallet()
  if (!ordinalsWallet || !ordinalsWallet.address) {
    throw new Error('Ordinals wallet not found. Please generate an ordinals wallet first.')
  }
  const ordinal_address = ordinalsWallet.address

  const target_btc_addr = ordinal_address
  const target_address = btcAddressToEvmAddress(target_btc_addr)

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('withdraw')
  const result = await withdraw_request(
    proxy,
    pubkey,
    token_address,
    target_address,
    amt,
    '', // bls_signature
    0n, // nonce
    btc_fee,
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
  order_params: WithdrawOrderSignatureRequest,
): Promise<string> {
  order_params.token_address = order_params.token_address.toLowerCase()
  order_params.target_addr = order_params.target_addr.toLowerCase()

  const signature_text = `Withdraw Order:
Token Address: ${order_params.token_address}
Target Address: ${order_params.target_addr}
Amount: ${order_params.amt}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of a withdraw order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
interface WithdrawOrderResponse {
  success: boolean
}
async function sendWithdrawOrder(to_send: WithdrawOrderRequest): Promise<WithdrawOrderResponse> {
  const url = getSwapBackendUrl('withdraw')

  return fetchWithErrors<WithdrawOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param token_addr
 * @param ordinal_addr
 * @param amt
 */
export async function prepareAndSendWithdrawOrderToOrdinalWallet(
  token_addr: string,
  ordinal_addr: string,
  amt: bigint,
): Promise<WithdrawOrderResponse> {
  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const target_btc_addr = ordinal_addr
  const target_addr = btcAddressToEvmAddress(target_btc_addr)

  const token1FeeBPS = 0n
  const token2FeeBPS = 0n

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('withdraw')
  const bip322_signature = await getWithdrawOrderSignature({
    token_address: token_addr,
    target_addr,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getWithdrawBLSSignature({
    pubkey,
    nonce,
    token_addr,
    target_addr,
    amt,
    btc_fee,
  })

  return await sendWithdrawOrder({
    pubkey,
    token_addr,
    target_addr,
    amt: amt.toString(),
    bls_signature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

/**
 *
 * @param token_addr
 * @param amt
 */
export async function prepareAndSendWithdrawOrderToSelfOrdinalWallet(
  token_addr: string,
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
  const target_btc_addr = ordinalsWallet.address
  const target_addr = btcAddressToEvmAddress(target_btc_addr)

  const token1FeeBPS = 0n
  const token2FeeBPS = 0n

  const nonce = await getSwapWalletNonce()

  const btc_fee = await requestMinerFee('withdraw')
  const bip322_signature = await getWithdrawOrderSignature({
    token_address: token_addr,
    target_addr,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getWithdrawBLSSignature({
    pubkey,
    nonce,
    token_addr,
    target_addr,
    amt,
    btc_fee,
  })

  return await sendWithdrawOrder({
    pubkey,
    token_addr,
    target_addr,
    amt: amt.toString(),
    bls_signature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}

/**
 *
 * @param pkscript
 * @param amt
 */
export async function getUnwrapResult(pkscript: string, amt: bigint): Promise<{ amt: bigint }> {
  const swap_info = await getSwapInfo()
  save_info(swap_info.wbtc_address, swap_info.factory_address)

  const pubkey = (await getSwapWalletFromDB())?.swapPubkey
  if (!pubkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }

  const proxy: UniswapInfoProxy = {
    balanceOf: checkSwapBalanceOf,
    reservesOf: checkPairReserves,
  }

  const btc_fee = await requestMinerFee('unwrap')
  const result = await unwrap_request(
    proxy,
    pubkey,
    pkscript,
    amt,
    '', // bls_signature
    0n, // nonce
    btc_fee,
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
async function getUnwrapOrderSignature(order_params: UnwrapOrderSignatureRequest): Promise<string> {
  order_params.pkscript = order_params.pkscript.toLowerCase()

  const signature_text = `Unwrap Order:
Pkscript: ${order_params.pkscript}
Amount: ${order_params.amt}
Token 1 Fee Bps: ${order_params.token1FeeBps}
Token 2 Fee Bps: ${order_params.token2FeeBps}
BTC Fee: ${order_params.btc_fee}

By signing this message, you authorize the creation of a withdraw order with the above parameters.`

  const signature = await signMessageLocalVerify(signature_text, 'ordinals')
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

  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  const bls_private_key = swapWallet.swapPrivkey.startsWith('0x')
    ? swapWallet.swapPrivkey.slice(2)
    : swapWallet.swapPrivkey
  const bls_private_key_buffer = Buffer.from(bls_private_key, 'hex')

  const bls_signature = bls12_381.shortSignatures.sign(P, bls_private_key_buffer)

  return `0x${bls_signature.x.toString(16).padStart(128, '0')}${bls_signature.y.toString(16).padStart(128, '0')}`
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
async function sendUnwrapOrder(to_send: UnwrapOrderRequest): Promise<UnwrapOrderResponse> {
  const url = getSwapBackendUrl('unwrap')

  return fetchWithErrors<UnwrapOrderResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(to_send),
  })
}

/**
 *
 * @param pkscript
 * @param amt
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

  const btc_fee = await requestMinerFee('unwrap')
  const bip322_signature = await getUnwrapOrderSignature({
    pkscript,
    amt: amt.toString(),
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
  })

  const bls_signature = await getUnwrapBLSSignature({
    pubkey,
    nonce,
    pkscript,
    amt,
    btc_fee,
  })

  return await sendUnwrapOrder({
    pubkey,
    pkscript,
    amt: amt.toString(),
    bls_signature,
    token1FeeBps: token1FeeBPS.toString(),
    token2FeeBps: token2FeeBPS.toString(),
    btc_fee: btc_fee.toString(),
    bip322_signature,
  })
}
