import { fetchWithErrors, getSwapBackendUrl } from '../core/helpers'

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
  const url = getSwapBackendUrl('check_base_brc20_balance')
  const body = {
    ordinal_address: btcAddress,
    token_address: tokenAddress,
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
