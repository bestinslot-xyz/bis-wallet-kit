# 🟠 Best in Slot – Bitcoin Wallet Kit

![Best in Slot](https://blog.bestinslot.xyz/img/og.png)

A lightweight JavaScript library for connecting Bitcoin wallets with a unified API. Perfect for
Bitcoin-native dApps and web apps needing simple, multi-wallet support.

## 🔌 Supported Wallets

- ✅ OKX
- ✅ Unisat
- ✅ Xverse
- ✅ Leather
- ✅ Magic Eden

## 📚 Documentation

Full guides and an API reference live in [`docs/`](./docs/README.md):

- [Getting started](./docs/getting-started.md)
- [Wallet connection](./docs/wallet-connection.md)
- [Inscriptions](./docs/inscriptions.md) · [BRC-2.0](./docs/brc20.md) · [Swap](./docs/swap.md) · [Balances](./docs/balances.md)
- [Testing](./docs/testing.md)

The full **API reference** is published at
<https://bestinslot-xyz.github.io/bis-wallet-kit/> (regenerated from source on
every push to `main`). To build it locally, run `pnpm docs:api` (output in
`docs/api/`).

## 🚀 Development & Build

Built with Vite, Vue 3, TypeScript and Tailwind CSS 4.

- [Vite](https://vite.dev/)
- [Vue 3](https://vuejs.org/)
- [Tailwind CSS](https://tailwindcss.com/)

The template uses Vue 3 `<script setup>` SFCs, check out the
[script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Publish
npm pack --dry-run

pnpm build
pnpm publish
```

## 📃 Examples

```ts
import { modal, wallet } from '@bestinslot/wallet-kit'

// Connect wallet
try {
  const data = await modal.connect()

  console.warn('Connected to wallet: ', data)
}
catch (e) {
  console.error('Connection failed: ', e)
}

// Disconnect from the wallet and clear session
modal.disconnect()

// Get stored wallet data
const data = wallet.getSession()

// Get Payment wallet
const paymentWallet = wallet.getPaymentWallet()
console.warn(paymentWallet?.address)

// Get BTC network
const network = wallet.getNetwork()

// Set BTC network
wallet.setNetwork('testnet') // defaults to mainnet

// Theme - defaults to 'system'
modal.setTheme('dark') // system, dark, light
```
