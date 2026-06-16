# Wallet connection

The `modal` and `wallet` namespaces cover connecting, reading the session,
switching networks, signing, and sending.

## The modal

```ts
import { modal } from '@bestinslot/wallet-kit'

modal.init()                 // create + mount the modal (call once)
const session = await modal.connect()  // show picker, resolve on connect
modal.disconnect()           // hide modal and clear the stored session
modal.setTheme('dark')       // 'light' | 'dark' | 'system' (default 'system')
```

Lower-level modal controls are also exported: `modal.create`, `modal.showConnect`,
`modal.showConnectConfirmation`, `modal.showError`, `modal.hide`.

Supported providers: `okx`, `unisat`, `xverse`, `leather`, `me` (Magic Eden),
and `local` (Node only — see below).

## Sessions

A session describes the connected wallet:

```ts
interface BISSession {
  provider: 'okx' | 'unisat' | 'xverse' | 'leather' | 'me' | 'local'
  wallets: BISWallet[]
  signature: string | null
}

interface BISWallet {
  address: string
  pubkey: string | null
  purpose: 'ordinals' | 'payment' | 'all'
}
```

Read it back at any time:

```ts
const session = wallet.getSession()
const ordinals = wallet.getOrdinalsWallet() // BISWallet | undefined
const payment = wallet.getPaymentWallet()   // BISWallet | undefined
```

Single-address wallets (OKX, Unisat, local) expose one wallet with
`purpose: 'all'`; both `getOrdinalsWallet()` and `getPaymentWallet()` return it.

## Networks

```ts
wallet.setNetwork('mainnet') // 'mainnet' | 'testnet' | 'signet', default 'mainnet'
const current = wallet.getNetwork() // the currently selected network
```

Bitcoin-level params follow the network: `mainnet` → bitcoin, `testnet`/`signet`
→ testnet parameters.

## Signing

```ts
// Sign and verify against the backend (BIP-322):
const sig = await wallet.signMessage('hello', 'payment')

// Sign and verify locally (offline BIP-322), no backend call:
const sigLocal = await wallet.signMessageLocalVerify('hello', 'payment')

// Deterministic (ECDSA) variant, verified locally:
const sigDet = await wallet.signMessageLocalVerifyDeterministic('hello')
```

`walletType` is `'ordinals' | 'payment' | 'all'`.

## Sending

```ts
const txid = await wallet.sendBTC('10000', 'bc1q…') // amount in sats (string)

const result = await wallet.sendInscription(
  inscriptionId,
  targetWallet, // WalletInfo — build with addressWalletInfo / opReturnWalletInfo
  feeRate,      // sats/vByte
  postage,      // sats or null for the default dust value
  dryRun,       // true returns tx details without broadcasting
)
```

Build a `WalletInfo` target with the top-level helpers:

```ts
import { addressWalletInfo, opReturnWalletInfo } from '@bestinslot/wallet-kit'

const toAddress = addressWalletInfo('bc1p…')
const toOpReturn = opReturnWalletInfo(outputScriptBuffer)
```

## The local wallet (Node only)

For tests, scripts, and backends, connect a wallet from a WIF private key. This
path is **only available outside the browser** and signs in-process — never use a
real-funds key where it could leak.

```ts
import { wallet } from '@bestinslot/wallet-kit'

const w = await wallet.connectLocalWallet(
  process.env.PRIVATE_KEY_WIF!,
  'signet',   // BISNetwork
  'p2tr',     // 'p2wpkh' | 'p2tr' (default 'p2wpkh')
  'unisat',   // source wallet: 'unisat' | 'okx' (default 'unisat')
)
console.log(w.address)
```

After this, the whole `wallet` / `mint` / `brc20` / `swap` API works against the
local key exactly as it would against an extension wallet. `sendBTC` is the one
operation the local provider does not implement.
