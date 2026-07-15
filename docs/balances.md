# Balances

The `balances` namespace queries token balances. It is read-only and does not require a connected
wallet — pass the address you care about. Set the network first with `wallet.setNetwork(...)`.

## Base BRC-20

```ts
import { balances } from '@bestinslot/wallet-kit'

const b = await balances.getBaseBRC20BalanceOfAddress(btcAddress, tokenAddress)
// {
//   availableBalanceIn18Decimals: bigint,
//   transferrableBalanceIn18Decimals: bigint,
//   decimals: number,
//   ticker: string,
// }
```

## BRC-2.0 programmable

```ts
// By token address:
const bal = await balances.getBRC20ProgBalanceOfAddress(bitcoinAddress, tokenAddress) // bigint

// By ticker:
const bal2 = await balances.getBRC20ProgBalanceOfTicker(bitcoinAddress, 'atat') // bigint

// Resolve a ticker to its programmable token address:
const tokenAddress = await balances.getBRC20ProgTokenAddressOfTicker('atat') // 0x…
```

Programmable balances are returned as raw `bigint` in 18 decimals. For example a balance of
`10000000000000000000000n` is `10000` tokens at 18 decimals.
