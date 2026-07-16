# Swap

The `swap` namespace wraps the Best in Slot swap/AMM: a dedicated swap wallet, liquidity, swaps,
withdrawals, quotes, and market data. Amounts are `bigint` in the token's base units.

## Swap wallet and status

```ts
import { bitcoinjs, swap, wallet } from '@bestinslot/wallet-kit'

const swapWallet = await swap.createSwapWallet() // generate + store the swap wallet
const status = await swap.getSwapStatus() // { reorg_handler_running, emergency_stop, … }
```

## Balances and pricing

```ts
const balances = await swap.getSwapBalances(ordinalsAddress) // SwapBalance[]
const one = await swap.getSwapBalance(tokenAddress) // bigint
const decimals = await swap.getTokenDecimals(tokenAddress) // number
const reserves = await swap.getPairReserves(pairAddress) // PairReserves
const pair = swap.getPairAddress(tokenA, tokenB) // deterministic, order-independent
const fee = await swap.getMinerFee('swap') // bigint (per order type)
```

## Trade

There are two swap directions, mirroring Uniswap's two router modes:

| Function          | Mode         | You fix                    | Bounded by              |
| ----------------- | ------------ | -------------------------- | ----------------------- |
| `swapExactInput`  | exact input  | the amount you **spend**   | minimum amount received |
| `swapExactOutput` | exact output | the amount you **receive** | maximum amount spent    |

```ts
// Exact input: spend exactly amountIn, receive at least amountOutMin.
await swap.swapExactInput(
  tokenInAddress,
  tokenOutAddress,
  amountIn, // bigint — exact amount spent
  amountOutMin, // bigint — expected/quoted output; slippage is applied to derive the enforced minimum
  slippageBPS // bigint, basis points
)

// Exact output: receive exactly amountOut, spend at most the quoted input + slippage.
await swap.swapExactOutput(
  tokenInAddress,
  tokenOutAddress,
  amountIn, // bigint — expected/quoted input (slippage applied to derive the max spent)
  amountOut, // bigint — exact amount received
  slippageBPS
)
```

Quote before sending with `getSwapExactInputResult` (for `swapExactInput`) and
`getSwapExactOutputResult` (for `swapExactOutput`).

Swaps and quotes fail fast with a clear `No swap pool with liquidity for …` error when the token
pair has no pool (e.g. an unsupported token-to-token pair), rather than failing deeper in the swap
math.

## Referrals

Both swap functions take an optional final `referrerId`. When a valid referral ID is supplied, a
share of the swap fee is credited to the referrer's smart wallet (and, where the referrer has
configured a return rate, part of that is rebated back to the swapper). An unknown or expired
referral is ignored — the swap still goes through as a normal swap.

```ts
await swap.swapExactInput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  amountOutMin,
  slippageBPS,
  referrerId
)
await swap.swapExactOutput(
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  amountOut,
  slippageBPS,
  referrerId
)
```

Resolve a referral ID to the referrer's swap pubkey and return-rate (bps) without sending a swap —
useful for showing referral info or validating an ID up front:

```ts
const { referrerPubkey, refReturnBps } = await swap.tryGetSwapReferrerInfo(mySwapPubkey, referrerId)
// referrerPubkey is undefined when the referral can't be resolved
```

## Liquidity

One of the two tokens must be WBTC.

```ts
await swap.addLiquidity(token1, token2, amount1Desired, amount2Desired, slippageBPS)

const { amountA, amountB } = await swap.getRemoveLiquidityResult(token1, token2, liquidity)
await swap.removeLiquidity(token1, token2, liquidity, amountA, amountB, slippageBPS)
```

Quote first with `getAddLiquidityResult` / `getRemoveLiquidityResult`. The amounts you pass are the
**expected** ones from the quote — `slippageBPS` derives the enforced on-chain minimums from them, so
passing an already slippage-adjusted floor applies slippage twice and silently weakens your protection.

## Move funds in and out

```ts
// Tokens: deposit pulls from your programmable balance, or auto-converts from
// your base BRC-20 balance (and creates the allowance) when it's short.
await swap.deposit(tokenAddress, amount, feeRate /* , createAllowanceIfNeeded = true */)
await swap.withdraw(tokenAddress, amount /* , targetAddress? */) // omit target → self

// BTC: wrapBtc deposits BTC into the smart wallet as WBTC; unwrap is the reverse and
// pays the BTC out on L1, so it takes the destination output script — not an address
// and not a token address. Quote first with getUnwrapResult(pkscript, amount).
await swap.wrapBtc(btcSats, feeRate)

// The network must match btcAddress, or you derive a valid-looking script that pays
// somewhere else. Deriving it from the kit's selected network keeps the two in step.
// (Signet uses bitcoinjs' testnet params.)
const network
  = wallet.getNetwork() === 'mainnet' ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet

const pkscript = bitcoinjs.address.toOutputScript(btcAddress, network).toString('hex')
await swap.unwrap(pkscript, amountSats)
```

## Market data

```ts
await swap.getKlines({
  /* GetKlinesRequest */
})
await swap.getPairVolumeOverDays(/* … */)
await swap.getActivityOfPair(pairAddress, limit, offset)
await swap.getWalletActivities(pubkey, pairAddress)
```

The `Get…Request` / `Get…Response`, `Kline`, `PairReserves`, `SwapBalance`, `PairActivityEntry`, and
`WalletActivityEntry` types are exported from the same namespace — see the
[generated API reference](./README.md#api-reference) for exact shapes.

## Reporting helpers

Everything is denominated in sats / WBTC. These pure helpers cover the common reporting derivations
so each consumer doesn't reimplement them.

```ts
// Buy/sell side relative to WBTC (you "buy" the token when you spend WBTC, "sell"
// it when you receive WBTC). Returns null for token-to-token swaps.
// For a *swap* activity entry, token_1 is the input and token_2 the output:
if (entry.type === 'swap1' || entry.type === 'swap2') {
  const side = swap.swapSide(entry.token_1, entry.token_2, wbtcAddress) // 'buy' | 'sell' | null
}

// Value conversion — the library stays oracle-free; you supply the BTC/USD rate.
const btc = swap.satsToBtc(amountSats) // sats → BTC (throws above ~90k BTC)
const usd = swap.satsToUsd(amountSats, btcUsd) // sats → USD
```

For **TVL of a WBTC pair**: it's `2 ×` the WBTC-side reserve (the other side is worth the same in
BTC terms), then convert with `satsToBtc` / `satsToUsd` — e.g.
`swap.satsToUsd(wbtcReserve * 2n, btcUsd)`.
