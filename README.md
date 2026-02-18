# 🟠 Best in Slot – Bitcoin Wallet Kit

![Best in Slot](https://blog.bestinslot.xyz/img/og.png)

A lightweight JavaScript library for connecting Bitcoin wallets with a unified API. Perfect for Bitcoin-native dApps and web apps needing simple, multi-wallet support.

## 🔌 Supported Wallets

- ✅ OKX
- ✅ Unisat
- ✅ Xverse
- ✅ Leather
- ✅ Magic Eden
- 🚧 Orange (coming soon)

## 🚀 Development & Build

Built with Vite, Vue 3, TypeScript and Tailwind CSS 4.

- [Vite](https://vite.dev/)
- [Vue 3](https://vuejs.org/)
- [Tailwind CSS](https://tailwindcss.com/)

The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

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
import { connect, disconnect, getSession } from '@bis/wallet-kit'

// Connect wallet
try {
  const data = await connect()

  console.log('Connected to wallet: ', data)
}
catch (e) {
  console.error('Connection failed: ', e)
}

// Disconnect from the wallet and clear session
disconnect()

// Get stored wallet data
const data = getSession()

// Get Ordinals wallet
const wallet = getOrdinalsWallet()

// Get Payment wallet
const wallet = getPaymentWallet()

// Get BTC network
const network = getNetwork()

// Set BTC network
setNetwork('testnet') // defaults to mainnet

// Theme - defaults to 'system'
setTheme('dark') // system, dark, light
```
