# Wallet Kit Documentation

`@bestinslot/wallet-kit` is a lightweight library for connecting Bitcoin wallets with a unified API,
plus helpers for inscriptions, BRC-2.0 programmable tokens, and swaps.

## Guides

- [Getting started](./getting-started.md) — install, connect a wallet, read a balance.
- [Wallet connection](./wallet-connection.md) — the modal, sessions, networks, signing, the local
  (Node) wallet.
- [Inscriptions](./inscriptions.md) — build and broadcast ordinal inscriptions (`mint`).
- [BRC-2.0 programmable](./brc20.md) — deposits, withdrawals, and smart-contract calls (`brc20`).
- [Swap](./swap.md) — liquidity, swaps, and quotes (`swap`).
- [Balances](./balances.md) — base BRC-20 and BRC-2.0 balances (`balances`).
- [Testing](./testing.md) — running the offline unit suite and the network integration suites.

## API reference

Generated from the source with TypeDoc:

```bash
pnpm docs:api   # writes HTML to docs/api/
```

Then open `docs/api/index.html`. The generated reference is the source of truth for full parameter
lists and return types; the guides above cover the common paths.

## The API at a glance

Everything is exported from the package root as namespaces:

```ts
import { balances, brc20, mint, modal, swap, wallet } from '@bestinslot/wallet-kit'
```

| Namespace  | What it does                                                                      |
| ---------- | --------------------------------------------------------------------------------- |
| `modal`    | Show the wallet-picker modal, connect/disconnect, theme.                          |
| `wallet`   | Session, addresses, network, signing, sending BTC/inscriptions, the local wallet. |
| `mint`     | Create ordinal inscriptions and estimate their fees.                              |
| `brc20`    | BRC-2.0 programmable deposits/withdrawals and contract calls.                     |
| `swap`     | Swap wallet, liquidity, swaps, quotes, and market data.                           |
| `balances` | Query base BRC-20 and BRC-2.0 balances.                                           |

Top-level helpers (`getEvmAddressFromBitcoinAddress`, `textInscription`, `jsonInscription`,
`delegateInscription`, `addressWalletInfo`, `opReturnWalletInfo`, …) and the `bitcoinjs` / `Buff`
re-exports are also available directly from the root.
