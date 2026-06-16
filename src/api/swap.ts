import {
  createAndBroadcastDepositOrder,
  getActivityOfPair as getActivityOfPairCore,
  getWalletActivities as getWalletActivitiesCore,
  prepareAndSendAddLiquidityOrder,
  prepareAndSendRemoveLiquidityOrder,
  prepareAndSendSwap2Order,
  prepareAndSendSwapOrder,
  prepareAndSendUnwrapOrder,
  prepareAndSendWithdrawOrderToOrdinalWallet,
  prepareAndSendWithdrawOrderToSelfOrdinalWallet,
} from '../core/bis_swap'

export {
  generateAndStoreSwapWallet as createSwapWallet,
  getAddLiquidityResult,
  getKlines,
  requestMinerFee as getMinerFee,
  getMinerFeesOfDepositOrder,
  getMinerFeesOfWrapOrder,
  getPairReserves,
  getPairVolumeOverDays,
  getRemoveLiquidityResult,
  getSwap2Result,
  getSwapBalance,
  getSwapBalances,
  getSwapResult,
  getSwapStatus,
  getTokenDecimals,
  getUnwrapResult,
  tryGetSwapReferrerInfo,
} from '../core/bis_swap' // Export all swap-related functions from the core BIS swap module
export type {
  GetActivityOfPairResponse,
  GetKlinesRequest,
  GetKlinesResponse,
  GetPairVolumeRequest,
  GetPairVolumeResponse,
  GetSwapStatusResponse,
  GetWalletActivitiesResponse,
  Kline,
  PairActivityEntry,
  PairReserves,
  SwapBalance,
  WalletActivityEntry,
} from '../core/bis_swap' // Export types related to wallet activities
export type { AllBalanceDetails } from '../core/helpers' // Export the AllBalanceDetails type from the core helpers module
export type { BISSwapWalletInfo } from '../core/store' // Export the BISSwapWalletInfo type from the core store module
export { calculatePairAddress as getPairAddress } from '../lib/uniswap_ops'

/**
 * Retrieves the wallet activities for a given public key and pair address.
 *
 * @param pubkey - The public key of the wallet for which to retrieve activities.
 * @param pairAddress - The address of the pair for which to retrieve activities.
 * @returns A promise that resolves to an array of wallet activities.
 */
export async function getWalletActivities(pubkey: string, pairAddress: string) {
  return await getWalletActivitiesCore({
    pubkey,
    pairAddress,
  })
}

/**
 * Retrieves activities for a pair.
 *
 * @param pairAddress - The address of the pair for which to retrieve activities.
 * @param limit - (Optional) The maximum number of activities to retrieve. Defaults to 20.
 * @param offset - (Optional) The number of activities to skip before starting to collect the result set. Defaults to 0.
 */
export async function getActivityOfPair(pairAddress: string, limit?: number, offset?: number) {
  return await getActivityOfPairCore({
    pair_address: pairAddress,
    limit: limit || 20,
    offset: offset || 0,
  })
}

/**
 * Adds liquidity to a specified token pair with the desired amounts and slippage tolerance.
 *
 * @param token1Address - The address of the first token in the pair.
 * @param token2Address - The address of the second token in the pair.
 * @param amount1Desired - The desired amount of the first token to add.
 * @param amount2Desired - The desired amount of the second token to add.
 * @param slippageBPS - The slippage tolerance in basis points.
 * @returns A promise that resolves to a boolean indicating the success of the operation.
 */
export async function addLiquidity(
  token1Address: string,
  token2Address: string,
  amount1Desired: bigint,
  amount2Desired: bigint,
  slippageBPS: bigint,
) {
  return (
    await prepareAndSendAddLiquidityOrder(
      token1Address,
      token2Address,
      amount1Desired,
      amount2Desired,
      slippageBPS,
    )
  ).success
}

/**
 * Removes liquidity from a specified token pair with the given parameters and slippage tolerance.
 *
 * @param token1Address - The address of the first token in the pair.
 * @param token2Address - The address of the second token in the pair.
 * @param liquidity - The amount of liquidity to remove.
 * @param amount1Min - The minimum amount of the first token to receive.
 * @param amount2Min - The minimum amount of the second token to receive.
 * @param slippageBPS - The slippage tolerance in basis points.
 * @returns A promise that resolves to a boolean indicating the success of the operation.
 */
export async function removeLiquidity(
  token1Address: string,
  token2Address: string,
  liquidity: bigint,
  amount1Min: bigint,
  amount2Min: bigint,
  slippageBPS: bigint,
) {
  return (
    await prepareAndSendRemoveLiquidityOrder(
      token1Address,
      token2Address,
      liquidity,
      amount1Min,
      amount2Min,
      slippageBPS,
    )
  ).success
}

/**
 * Executes a token swap between two specified tokens with the given parameters and slippage tolerance.
 *
 * @param tokenInAddress - The address of the token to swap from.
 * @param tokenOutAddress - The address of the token to swap to.
 * @param amountIn - The amount of the input token to swap.
 * @param amountOutMin - The minimum amount of the output token to receive from the swap.
 * @param slippageBPS - The slippage tolerance in basis points.
 * @param referrerId - An optional referral ID. When valid, a share of the swap fee is credited to the referrer; an invalid referral is ignored and the swap proceeds normally.
 * @returns A promise that resolves to a boolean indicating the success of the swap operation.
 */
export async function swap(
  tokenInAddress: string,
  tokenOutAddress: string,
  amountIn: bigint,
  amountOutMin: bigint,
  slippageBPS: bigint,
  referrerId?: string,
) {
  return (
    await prepareAndSendSwapOrder(
      tokenInAddress,
      tokenOutAddress,
      amountIn,
      amountOutMin,
      slippageBPS,
      referrerId,
    )
  ).success
}

/**
 * Executes a token swap between two specified tokens with the given parameters and slippage tolerance, using the updated swap logic.
 *
 * @param tokenInAddress - The address of the token to swap from.
 * @param tokenOutAddress - The address of the token to swap to.
 * @param amountIn - The amount of the input token to swap.
 * @param amountOutMin - The minimum amount of the output token to receive from the swap.
 * @param slippageBPS - The slippage tolerance in basis points.
 * @param referrerId - An optional referral ID. When valid, a share of the swap fee is credited to the referrer; an invalid referral is ignored and the swap proceeds normally.
 * @returns A promise that resolves to a boolean indicating the success of the swap operation.
 */
export async function swap2(
  tokenInAddress: string,
  tokenOutAddress: string,
  amountIn: bigint,
  amountOutMin: bigint,
  slippageBPS: bigint,
  referrerId?: string,
) {
  return (
    await prepareAndSendSwap2Order(
      tokenInAddress,
      tokenOutAddress,
      amountIn,
      amountOutMin,
      slippageBPS,
      referrerId,
    )
  ).success
}

/**
 * Unwraps a specified amount of wrapped tokens back to their original form with the given slippage tolerance.
 * @param tokenAddress - The address of the wrapped token to unwrap.
 * @param amount - The amount of the wrapped token to unwrap.
 * @returns A promise that resolves to a boolean indicating the success of the unwrap operation.
 */
export async function unwrap(tokenAddress: string, amount: bigint) {
  return (await prepareAndSendUnwrapOrder(tokenAddress, amount)).success
}

/**
 * Deposits a specified amount of a token into the swap contract for a given pair.
 *
 * @param tokenAddress - The address of the token to deposit.
 * @param amount - The amount of the token to deposit, specified as a bigint.
 * @param feeRate - The fee rate for the deposit operation.
 * @param createAllowanceIfNeeded - Whether to create an allowance if needed.
 * @returns A promise that resolves to an array of transaction IDs related to the deposit operation.
 */
export async function deposit(
  tokenAddress: string,
  amount: bigint,
  feeRate: number,
  createAllowanceIfNeeded: boolean = true,
): Promise<string[]> {
  return await createAndBroadcastDepositOrder(
    tokenAddress,
    amount,
    feeRate,
    createAllowanceIfNeeded,
  )
}

/**
 * Withdraws a specified amount of a token to a target address.
 *
 * @param tokenAddress - The address of the token to withdraw.
 * @param amount - The amount of the token to withdraw, specified as a bigint.
 * @param targetAddress - (Optional) The target address to which the tokens should be withdrawn. If not provided, the tokens will be withdrawn to the user's own Ordinals wallet.
 * @returns A promise that resolves when the withdrawal process is complete.
 */
export async function withdraw(
  tokenAddress: string,
  amount: bigint,
  targetAddress?: string,
): Promise<boolean> {
  if (targetAddress) {
    return (await prepareAndSendWithdrawOrderToOrdinalWallet(tokenAddress, targetAddress, amount))
      .success
  }
  else {
    return (await prepareAndSendWithdrawOrderToSelfOrdinalWallet(tokenAddress, amount)).success
  }
}
