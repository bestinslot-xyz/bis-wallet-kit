# Getting started

## Install

```bash
pnpm add @bestinslot/wallet-kit
# or: npm install @bestinslot/wallet-kit
```

The package ships as ESM only, in two flavours resolved automatically by your environment:

- **browser** — extension wallets (OKX, Unisat, Xverse, Leather, Magic Eden) + the framework-free
  connect modal, plus all the feature APIs.
- **server** (Node/Bun) — the same feature APIs (swap, inscriptions, BRC-2.0, balances) connected
  via a local WIF wallet (`wallet.connectLocalWallet`), with no Vue or modal. Ideal for
  headless/automated use.

Bundlers and Node pick the right one via conditional exports; you can also import explicitly with
`@bestinslot/wallet-kit/browser` or `@bestinslot/wallet-kit/node`. For framework apps there are also
`@bestinslot/wallet-kit/react` and `@bestinslot/wallet-kit/vue` adapter entries, and a modal-free
`@bestinslot/wallet-kit/core`.

The connect modal is framework-free, so the default browser entry needs **no** UI framework. `vue`
and `react` are **optional** peer dependencies — install one only when you import its adapter
(`@bestinslot/wallet-kit/vue` or `@bestinslot/wallet-kit/react`):

```bash
pnpm add vue   # only if you use the /vue adapter
pnpm add react # only if you use the /react adapter
```

## Connect a wallet

In a browser, open the modal and let the user pick a wallet (OKX, Unisat, Xverse, Leather, or Magic
Eden):

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

`modal.connect()` resolves with a [`BISSession`](./wallet-connection.md#sessions) once the user
picks and connects a wallet, and rejects if they cancel or it fails.

### On a server (Node/Bun)

There's no modal — connect with a WIF private key instead, then use the same feature APIs:

```ts
import { wallet } from '@bestinslot/wallet-kit' // resolves to the server build in Node

await wallet.connectLocalWallet(process.env.PRIVATE_KEY_WIF!, 'signet', 'p2tr', 'unisat')
```

See [Wallet connection](./wallet-connection.md#the-local-wallet-node-only) for details.

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

- [Wallet connection](./wallet-connection.md) — sessions, signing, theme, the Node-only local
  wallet.
- [Inscriptions](./inscriptions.md), [BRC-2.0](./brc20.md), [Swap](./swap.md),
  [Balances](./balances.md).
