import { Buffer } from 'node:buffer'
import { ethCallOnPublicRpc, fetchWithErrors, getSwapBackendUrl } from '../core/helpers'
import { getEvmAddressFromBitcoinAddress } from './helpers'

const BRC20_CONTROLLER_ABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'OwnableInvalidOwner',
    type: 'error',
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'OwnableUnauthorizedAccount',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'spender', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { indexed: true, internalType: 'address', name: 'contract_address', type: 'address' },
    ],
    name: 'BRC20Created',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'previousOwner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'newOwner', type: 'address' },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'account', type: 'address' },
    ],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'burn',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes', name: 'ticker', type: 'bytes' }],
    name: 'getTickerAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes', name: 'ticker', type: 'bytes' },
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'newOwner', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]
const BRC20_CONTROLLER_ADDRESS = '0xc54dd4581af2dbf18e4d90840226756e9d2b3cdb'

/**
 * Interface representing the balance information for a base BRC-20 token, including the available balance, transferrable balance, decimals, and ticker.
 * The balances are represented in 18 decimals as per the BRC-20 standard, and the decimals field indicates the actual number of decimals for the token. The ticker field provides the symbol for the token.
 *
 * The availableBalanceIn18Decimals and transferrableBalanceIn18Decimals fields are returned as strings from the API and converted to bigint in the checkBaseBRC20BalanceOfAddress function for easier handling of large numbers. The decimals field is used to determine how to convert the 18-decimal balances to the actual token balance based on the token's specific decimal places. The ticker field is used for display purposes to show the token symbol alongside the balance information.
 *
 * availableBalanceIn18Decimals: The total balance of the specified BRC-20 token that is available in the Bitcoin address, represented in 18 decimals as per the BRC-20 standard. This balance includes all tokens that are currently held in the address, regardless of whether they are transferrable or not.
 * transferrableBalanceIn18Decimals: The portion of the available balance that is currently transferrable, represented in 18 decimals. This balance indicates how many tokens can be transferred from the address at the current time, taking into account any restrictions or locks on the tokens.
 * decimals: The number of decimal places that the specific BRC-20 token uses. This field is important for converting the 18-decimal balances to the actual token balance, as different tokens may have different decimal places.
 * ticker: The symbol or abbreviation for the BRC-20 token, used for display purposes to identify the token alongside its balance information.
 */
export interface BaseBRC20Balance {
  availableBalanceIn18Decimals: bigint
  transferrableBalanceIn18Decimals: bigint
  decimals: number
  ticker: string
}

/**
 * Checks the base BRC-20 token balance for a given Bitcoin address and token address by making an API call to the swap backend.
 *
 * @param btcAddress The Bitcoin address to check the BRC-20 balance for.
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 *
 * @returns {Promise<BaseBRC20Balance>} A promise that resolves to an object containing the available balance, transferrable balance, decimals, and ticker for the specified Bitcoin address and BRC-20 token address. The balances are returned as strings from the API and converted to bigint in this function.
 */
export async function getBaseBRC20BalanceOfAddress(
  btcAddress: string,
  tokenAddress: string,
): Promise<BaseBRC20Balance> {
  const tokenAddressUpperCase = tokenAddress.toUpperCase()
  const url = getSwapBackendUrl('check_base_brc20_balance')
  const body = {
    ordinal_address: btcAddress,
    token_address: tokenAddressUpperCase,
  }

  const result = await fetchWithErrors<{ result: any }>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return {
    availableBalanceIn18Decimals: BigInt(result.result.available_balance_in_18_dec),
    transferrableBalanceIn18Decimals: BigInt(result.result.transferrable_balance_in_18_dec),
    decimals: result.result.decimals,
    ticker: result.result.ticker,
  }
}

/**
 * Checks the BRC2.0 token balance for a given Bitcoin address and token address by making an API call to the swap backend. This function is used for checking the balance of BRC-20 tokens that are not based on the base BRC-20 standard, and it returns the balance as a single bigint value representing the total balance in 18 decimals.
 *
 * @param bitcoinAddress The Bitcoin address to check the BRC-20 balance for.
 * @param tokenAddress The address of the BRC-20 token to check the balance for.
 *
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the total balance in 18 decimals for the specified Bitcoin address and BRC-20 token address.
 */
export async function getBRC20ProgBalanceOfAddress(
  bitcoinAddress: string,
  tokenAddress: string,
): Promise<bigint> {
  const url = getSwapBackendUrl('check_brc20_balance')
  const body = {
    ordinal_address: bitcoinAddress,
    token_address: tokenAddress,
  }

  const result = await fetchWithErrors<{ result: any }>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // 3. Convert the result to a BigInt
  return BigInt(result.result)
}

/**
 * Checks the BRC2.0 token balance for a given Bitcoin address and ticker by making an API call to the swap backend. This function is used for checking the balance of BRC-20 tokens that are not based on the base BRC-20 standard, and it returns the balance as a single bigint value representing the total balance in 18 decimals.
 *
 * @param bitcoinAddress The Bitcoin address to check the BRC-20 balance for.
 * @param ticker The ticker of the BRC-20 token to check the balance for.
 *
 * @returns {Promise<bigint>} A promise that resolves to a bigint representing the total balance in 18 decimals for the specified Bitcoin address and BRC-20 token.
 */
export async function getBRC20ProgBalanceOfTicker(
  bitcoinAddress: string,
  ticker: string,
): Promise<bigint> {
  const tickerBytes = Buffer.from(ticker, 'utf-8')
  const result = await ethCallOnPublicRpc(
    BRC20_CONTROLLER_ADDRESS,
    BRC20_CONTROLLER_ABI,
    'balanceOf',
    [tickerBytes, getEvmAddressFromBitcoinAddress(bitcoinAddress)],
  )

  return BigInt(result)
}

/**
 * Get token address of a ticker in BRC2.0 by making an API call to the public RPC.
 *
 * @param ticker The ticker of the BRC-20 token.
 *
 * @returns {Promise<string>} A promise that resolves to a string representing the token address of the specified ticker.
 */
export async function getBRC20ProgTokenAddressOfTicker(ticker: string): Promise<string> {
  const tickerBytes = Buffer.from(ticker, 'utf-8')
  const result = await ethCallOnPublicRpc(
    BRC20_CONTROLLER_ADDRESS,
    BRC20_CONTROLLER_ABI,
    'getTickerAddress',
    [tickerBytes],
  )

  // Use last 40 characters of the result as the token address (20 bytes in hex)
  const tokenAddress = `0x${result.slice(-40)}`

  return tokenAddress
}
