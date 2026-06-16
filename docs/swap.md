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

There are two swap directions, mirroring Uniswap's two router modes:

| Function | Mode | You fix | Bounded by |
|----------|------|---------|------------|
| `swapExactInput` | exact input | the amount you **spend** | minimum amount received |
| `swapExactOutput` | exact output | the amount you **receive** | maximum amount spent |

```ts
// Exact input: spend exactly amountIn, receive at least amountOutMin.
await swap.swapExactInput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,      // bigint — exact amount spent
  amountOutMin,  // bigint — expected/quoted output; slippage is applied to derive the enforced minimum
  slippageBPS,   // bigint, basis points
)

// Exact output: receive exactly amountOut, spend at most the quoted input + slippage.
await swap.swapExactOutput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,      // bigint — expected/quoted input (slippage applied to derive the max spent)
  amountOut,     // bigint — exact amount received
  slippageBPS,
)
```

Quote before sending with `getSwapExactInputResult` (for `swapExactInput`) and
`getSwapExactOutputResult` (for `swapExactOutput`).

## Referrals

Both swap functions take an optional final `referrerId`. When a valid referral
ID is supplied, a share of the swap fee is credited to the referrer's smart
wallet (and, where the referrer has configured a return rate, part of that is
rebated back to the swapper). An unknown or expired referral is ignored — the
swap still goes through as a normal swap.

```ts
await swap.swapExactInput(tokenInAddress, tokenOutAddress, amountIn, amountOutMin, slippageBPS, referrerId)
await swap.swapExactOutput(tokenInAddress, tokenOutAddress, amountIn, amountOut, slippageBPS, referrerId)
```

Resolve a referral ID to the referrer's swap pubkey and return-rate (bps)
without sending a swap — useful for showing referral info or validating an ID up
front:

```ts
const { referrerPubkey, refReturnBps } = await swap.tryGetSwapReferrerInfo(mySwapPubkey, referrerId)
// referrerPubkey is undefined when the referral can't be resolved
```

## Liquidity

```ts
await swap.addLiquidity(token1, token2, amount1Desired, amount2Desired, slippageBPS)
await swap.removeLiquidity(/* … */)
```

Quote first with `getAddLiquidityResult` / `getRemoveLiquidityResult`.

## Move funds in and out

```ts
// Tokens: deposit pulls from your programmable balance, or auto-converts from
// your base BRC-20 balance (and creates the allowance) when it's short.
await swap.deposit(tokenAddress, amount, feeRate /*, createAllowanceIfNeeded = true */)
await swap.withdraw(tokenAddress, amount /*, targetAddress? */) // omit target → self

// BTC: wrap deposits BTC into the smart wallet as WBTC; unwrap is the reverse.
await swap.wrap(btcSats, feeRate)
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
