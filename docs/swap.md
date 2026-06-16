# Swap

The `swap` namespace wraps the Best in Slot swap/AMM: a dedicated swap wallet,
liquidity, swaps, withdrawals, quotes, and market data. Amounts are `bigint` in
the token's base units.

## Swap wallet and status

```ts
import { swap } from '@bestinslot/wallet-kit'

const swapWallet = await swap.createSwapWallet() // generate + store the swap wallet
const status = await swap.getSwapStatus()        // { reorg_handler_running, emergency_stop, … }
```

## Balances and pricing

```ts
const balances = await swap.getSwapBalances(ordinalsAddress) // SwapBalance[]
const one = await swap.getSwapBalance(tokenAddress)          // bigint
const decimals = await swap.getTokenDecimals(tokenAddress)   // number
const reserves = await swap.getPairReserves(pairAddress)     // PairReserves
const pair = swap.getPairAddress(tokenA, tokenB)             // deterministic, order-independent
const fee = await swap.getMinerFee('swap')                   // bigint (per order type)
```

## Trade

```ts
await swap.swap(
  tokenInAddress,
  tokenOutAddress,
  amountIn,      // bigint
  amountOutMin,  // bigint
  slippageBPS,   // bigint, basis points
)
```

`swap2` is the variant for the second routing path; use `getSwapResult` /
`getSwap2Result` to quote before sending.

## Liquidity

```ts
await swap.addLiquidity(token1, token2, amount1Desired, amount2Desired, slippageBPS)
await swap.removeLiquidity(/* … */)
```

Quote first with `getAddLiquidityResult` / `getRemoveLiquidityResult`.

## Move funds in and out

```ts
await swap.deposit(tokenAddress, amount, feeRate /*, createAllowanceIfNeeded = true */)
await swap.withdraw(tokenAddress, amount /*, targetAddress? */) // omit target → self
await swap.unwrap(tokenAddress, amount)
```

## Market data

```ts
await swap.getKlines({ /* GetKlinesRequest */ })
await swap.getPairVolumeOverDays(/* … */)
await swap.getActivityOfPair(pairAddress, limit, offset)
await swap.getWalletActivities(pubkey, pairAddress)
```

The `Get…Request` / `Get…Response`, `Kline`, `PairReserves`, `SwapBalance`,
`PairActivityEntry`, and `WalletActivityEntry` types are exported from the same
namespace — see the [generated API reference](./README.md#api-reference) for exact
shapes.
