# Getting started

## Install

```bash
pnpm add @bestinslot/wallet-kit
# or: npm install @bestinslot/wallet-kit
```

`vue` is a peer dependency (the connect modal is a Vue component):

```bash
pnpm add vue
```

The package ships as ESM only.

## Connect a wallet

In a browser, open the modal and let the user pick a wallet
(OKX, Unisat, Xverse, Leather, or Magic Eden):

```ts
import { modal, wallet } from '@bestinslot/wallet-kit'

modal.init() // mount the modal once, e.g. at app start

try {
  const session = await modal.connect()
  console.log('Connected:', session)
}
catch (e) {
  console.error('Connection failed:', e)
}
```

`modal.connect()` resolves with a [`BISSession`](./wallet-connection.md#sessions)
once the user picks and connects a wallet, and rejects if they cancel or it fails.

## Read the session and a balance

```ts
import { wallet } from '@bestinslot/wallet-kit'

const session = wallet.getSession()
const payment = wallet.getPaymentWallet()

if (payment) {
  const sats = await wallet.getCardinalBalance(payment.address)
  console.log(`${sats} sats spendable`)
}
```

## Pick a network

The default network is `mainnet`. Switch before making calls:

```ts
wallet.setNetwork('signet') // 'mainnet' | 'testnet' | 'signet'
```

## Next steps

- [Wallet connection](./wallet-connection.md) — sessions, signing, theme, the Node-only local wallet.
- [Inscriptions](./inscriptions.md), [BRC-2.0](./brc20.md), [Swap](./swap.md), [Balances](./balances.md).
