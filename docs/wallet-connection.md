# Wallet connection

The `modal` and `wallet` namespaces cover connecting, reading the session, switching networks,
signing, and sending.

## The modal

```ts
import { modal } from '@bestinslot/wallet-kit'

modal.init() // create + mount the modal (call once)
const session = await modal.connect() // show picker, resolve on connect
modal.disconnect() // hide modal and clear the stored session
modal.setTheme('dark') // 'light' | 'dark' | 'system' (default 'system')
```

Lower-level modal controls are also exported: `modal.create`, `modal.showConnect`,
`modal.showConnectConfirmation`, `modal.showError`, `modal.hide`.

Supported providers: `okx`, `unisat`, `xverse`, `leather`, and `local` (Node only — see below).

## Sessions

A session describes the connected wallet:

```ts
interface BISSession {
  provider: 'okx' | 'unisat' | 'xverse' | 'leather' | 'local'
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
const payment = wallet.getPaymentWallet() // BISWallet | undefined
```

Single-address wallets (OKX, Unisat, local) expose one wallet with `purpose: 'all'`; both
`getOrdinalsWallet()` and `getPaymentWallet()` return it.

## Networks

```ts
wallet.setNetwork('mainnet') // 'mainnet' | 'testnet' | 'signet', default 'mainnet'
const current = wallet.getNetwork() // the currently selected network
```

Bitcoin-level params follow the network: `mainnet` → bitcoin, `testnet`/`signet` → testnet
parameters.

### Backend endpoints

Every network has its own set of backend base URLs. `wallet.setEndpoints` overrides any of them, per
network; keys you leave out keep their defaults:

```ts
wallet.setEndpoints({
  mainnet: { rpc: 'https://my-brc20-rpc.example' },
  signet: {
    indexer: 'https://signet-api.example/v1/data',
    sequencerRead: 'https://signet-api.example/v1/data',
  },
})

wallet.getEndpoints() // effective URLs for the selected network
wallet.getEndpoints('signet') // ...or for a given one
```

Each call replaces the previous overrides, so `wallet.setEndpoints({})` restores the defaults.
Unknown keys and non-http(s) URLs throw.

| Key             | Serves                                                                                                                                                             | Default (mainnet / signet)                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `indexer`       | UTXOs, balances, raw transactions                                                                                                                                  | `https://ts-proxy.bestinslot.xyz/v3/<network>`                         |
| `tx`            | `testmempoolaccept`, `sendrawtransactions`                                                                                                                         | `https://ts-proxy.bestinslot.xyz/v3/<network>`                         |
| `sequencerRead` | Swap display reads: tokens, pairs table, volume, klines, TVL, pair / recent / wallet activity, token decimals                                                      | `https://sa-proxy.bestinslot.xyz` / `https://sas-proxy.bestinslot.xyz` |
| `sequencer`     | Every other swap route: status, swap info, miner fee, nonce, balances, reserves, referrer info, allowance checks, deposit, wrap, liquidity, swap, withdraw, unwrap | `https://sa-proxy.bestinslot.xyz` / `https://sas-proxy.bestinslot.xyz` |
| `rpc`           | BRC2.0 JSON-RPC (`eth_call`), BIP-322 verification                                                                                                                 | `https://rpc.brc20.build` / `https://rpc-signet.brc20.build`           |

The `indexer`, `tx` and `rpc` endpoints serve the default chain data providers. To read chain data
from your own node or API instead, see [Chain data providers](./chain-providers.md).

Requests go to `<base>/<route>`; a trailing slash on the base is ignored. `testnet` has `indexer`
and `tx` (under `/v3/testnet`) and no swap sequencer or RPC unless you configure them.

When a base URL's path starts with `/v1`, the kit reads `<origin>/v1/info` once per origin before
the first request to it and checks that the `network` it reports matches `wallet.getNetwork()`. On a
mismatch the request throws (`Endpoint … serves 'mainnet', but the selected network is 'signet'`)
instead of reaching the wrong network's service.

### Backend errors

A failed backend request throws `BackendError` (exported at the top level). It carries the HTTP
`status` (`undefined` when no response arrived), the backend's `code` when the body has one, the
backend's own text as `detail`, the requested `url`, and the backend's request ID as `ref` (its logs
carry the same ID, so quote it when reporting a failure). `message` is
`API Request Failed: <detail>`. Branch on `code`: the swap sequencer sends stable codes such as
`WALLET_KEY_MISMATCH`, `FEES_INSUFFICIENT`, `ORDER_REJECTED`, `TX_MISMATCH`, `BROADCAST_FAILED`,
`SEQUENCER_HALTED` and `SEQUENCER_BUSY`, and a status-based default (`INVALID_REQUEST`, `NOT_FOUND`,
`INTERNAL_ERROR`, ...) for every other error.

```ts
try {
  await swap.deposit(/* ... */)
} catch (e) {
  if (e instanceof BackendError && e.code === 'WALLET_KEY_MISMATCH') {
    // Ask the user to sign in with the wallet app they first deposited with.
  }
}
```

## Signing

```ts
// Sign and verify (BIP-322) with the BRC2.0 chain's own verifier, through the BRC2.0 RPC provider
// (locally on a network with no BRC2.0 RPC; see chain-providers.md):
const sig = await wallet.signMessage('hello', 'payment')

// Sign and verify locally (offline BIP-322), no backend call:
const sigLocal = await wallet.signMessageLocalVerify('hello', 'payment')

// Deterministic (ECDSA) variant, verified locally:
const sigDet = await wallet.signMessageLocalVerifyDeterministic('hello')
```

`walletType` is `'ordinals' | 'payment' | 'all'`.

### Account switches inside the wallet

Unisat and OKX let the user switch accounts inside the extension after connecting. Before each
signature the kit asks the wallet for its active account. If it no longer matches the session, the
kit clears the session and throws `WalletAccountChangedError` ("Connected wallet account changed.
Please reconnect.") without prompting for a signature.

To react as soon as the switch happens, subscribe:

```ts
const unsubscribe = wallet.subscribeToAccountChanges(
  ({ provider, previousAddresses, accounts }) => {
    // The session is already cleared: prompt the user to reconnect.
  }
)

try {
  await wallet.signMessageLocalVerify('hello', 'payment')
} catch (e) {
  if (e instanceof wallet.WalletAccountChangedError) {
    // prompt reconnect
  }
}
```

## Sending

```ts
const txid = await wallet.sendBTC(10000, 'bc1q…') // amount in sats (number)

const result = await wallet.sendInscription(
  inscriptionId,
  targetWallet, // WalletInfo — build with addressWalletInfo / opReturnWalletInfo
  feeRate, // sats/vByte
  postage, // sats or null for the default dust value
  dryRun // true returns tx details without broadcasting
)
```

Build a `WalletInfo` target with the top-level helpers:

```ts
import { addressWalletInfo, opReturnWalletInfo } from '@bestinslot/wallet-kit'

const toAddress = addressWalletInfo('bc1p…')
const toOpReturn = opReturnWalletInfo(outputScriptBuffer)
```

## The local wallet (Node only)

For tests, scripts, and backends, connect a wallet from a WIF private key. This path is **only
available outside the browser** and signs in-process — never use a real-funds key where it could
leak.

```ts
import { wallet } from '@bestinslot/wallet-kit'

const w = await wallet.connectLocalWallet(
  process.env.PRIVATE_KEY_WIF!,
  'signet', // BISNetwork
  'p2tr', // 'p2wpkh' | 'p2tr' (default 'p2wpkh')
  'unisat' // source wallet: 'unisat' | 'okx' (default 'unisat')
)
console.log(w.address)
```

After this, the whole `wallet` / `mint` / `brc20` / `swap` API works against the local key exactly
as it would against an extension wallet. `sendBTC` is the one operation the local provider does not
implement.
