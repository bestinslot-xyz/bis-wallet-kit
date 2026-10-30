# Chain data providers

wallet-kit reads Bitcoin chain data (UTXOs, balances, raw transactions), tests and broadcasts
transactions, and makes BRC-2.0 `eth_call` reads through two providers per network. By default these
are `BisChainProvider` and `BisBrc20RpcProvider`, which use the Best in Slot API and the endpoints
set with `wallet.setEndpoints`. Supply your own to read from a data source you run: a Node process
can query its own `bitcoind` and indexer in-process, and a browser app can call whatever API its own
server exposes.

```ts
import type { Brc20RpcProvider, ChainProvider } from '@bestinslot/wallet-kit'
import { wallet } from '@bestinslot/wallet-kit'

const chain: ChainProvider = {/* ... */}
const brc20Rpc: Brc20RpcProvider = {/* ... */}

wallet.setProviders({ signet: { chain, brc20Rpc } })
wallet.getProviders() // the providers in effect for the selected network
```

`setProviders` works like `setEndpoints`: it takes one entry per network, a network or key you leave
out keeps its default provider, each call replaces the previous overrides, and
`wallet.setProviders({})` restores the defaults. Unknown networks or keys, and providers missing a
method, throw. `setProviders` and `getProviders` are also exported from
`@bestinslot/wallet-kit/core`.

The swap sequencer endpoints (`sequencer`, `sequencerRead`) are separate from these providers and
stay configured through `setEndpoints`.

## `ChainProvider`

```ts
interface ChainProvider {
  cardinalUtxos: (address: string) => Promise<Utxo[]>
  ordinalUtxos: (address: string) => Promise<OrdinalUtxo[]>
  balance: (address: string) => Promise<ChainBalance>
  txHex: (txid: string) => Promise<string>
  testMempoolAccept: (txHexes: string[]) => Promise<MempoolAcceptResult[]>
  broadcast: (txHexes: string[]) => Promise<string[]> // txids
}
```

| Method              | Returns                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cardinalUtxos`     | The address's unspent outputs that carry no inscriptions and no runes. These fund every transaction the kit builds.                     |
| `ordinalUtxos`      | The address's unspent outputs that carry inscriptions. Used to find an inscription before sending it or using it as a parent.           |
| `balance`           | The address's confirmed balance, and the amount unconfirmed transactions add to it (negative when they spend from it).                  |
| `txHex`             | The raw transaction, hex encoded. The kit reads the transactions that created the outputs it spends.                                    |
| `testMempoolAccept` | One verdict per transaction, in order. Later transactions in the list may spend outputs of earlier ones, as `testmempoolaccept` allows. |
| `broadcast`         | The txids of the broadcast transactions, in order. The list is a chain (commit, reveal, send), so broadcast them in the order given.    |

Every method throws when it cannot answer.

### Types

The types carry only the fields wallet-kit reads, so a provider never fills a field nothing uses.

```ts
interface Utxo {
  txid: string // the transaction that created the output
  vout: number // the output's index in it
  value: number // sats
}

interface OrdinalUtxo extends Utxo {
  inscription_ids: string[] // the inscriptions on the output
  satpoints: string[] // `txid:vout:offset` of each inscription, same order
  block_height?: number | null // confirmation height, null while unconfirmed (optional)
}

interface MempoolAcceptResult {
  allowed: boolean
  'reject-reason'?: string // why, when allowed is false
}

interface ChainBalance {
  confirmed: number // sats in confirmed outputs that no mempool transaction spends
  mempool: number // sats in unspent outputs that unconfirmed transactions create
}
```

Both `ChainBalance` amounts cover every output of the address, inscribed and runic ones included,
and the address's spendable total is their sum.

`MempoolAcceptResult` matches the entries of Bitcoin Core's `testmempoolaccept`, so a provider
backed by `bitcoind` can return that RPC's result as it is.

The kit derives each output's script type from the address, since every output of one address shares
its output script.

## `Brc20RpcProvider`

```ts
interface Brc20RpcProvider {
  request: (method: string, params: unknown[]) => Promise<unknown>
}
```

`request` sends one BRC-2.0 JSON-RPC request and returns its `result`, and throws when the request
fails or the response carries an `error`. wallet-kit uses it for `eth_call` reads, such as frBTC and
BRC-2.0 token balances.

## Rules

**Cardinal means no inscriptions and no runes.** `cardinalUtxos` returns only outputs that carry
neither, because the kit spends them as plain BTC and would otherwise burn or move an inscription or
rune by accident. A provider that cannot tell, for example because its indexer does not track runes,
throws instead of returning the output.

**Mempool data is optional.** A provider can return confirmed outputs only, minus those that mempool
transactions spend, and report `mempool: 0` from `balance`. wallet-kit tracks the outputs of its own
pending transactions above the provider: while a flow chains a commit, a reveal and a
send-to-OP_RETURN, it drops the outputs they spend and adds the outputs they create. Those chained
flows therefore work without mempool data. BTC the address receives from elsewhere becomes spendable
once it confirms.

## Signature checks

`wallet.signMessage` checks the wallet's BIP-322 signature after signing, with the BRC2.0 chain's
own verifier: an `eth_call` to the BIP-322 precompile at
`0x00000000000000000000000000000000000000fe` through the network's `Brc20RpcProvider`. A signature
that passes is one the chain accepts, whichever providers are set. On a network with no BRC2.0 RPC,
the kit verifies it locally with the bundled BIP-322 verifier. `signMessageLocalVerify` and
`signMessageLocalVerifyDeterministic` always verify locally.

## The default providers

`BisChainProvider` and `BisBrc20RpcProvider` read their endpoints from `wallet.setEndpoints` for the
selected network. Pass endpoints to their constructors to pin a provider to specific URLs instead:

```ts
import { BisBrc20RpcProvider, BisChainProvider, wallet } from '@bestinslot/wallet-kit'

wallet.setProviders({
  signet: {
    chain: new BisChainProvider({ indexer: 'https://indexer.example', tx: 'https://tx.example' }),
    brc20Rpc: new BisBrc20RpcProvider({ rpc: 'https://rpc.example' }),
  },
})
```

A key left out of a constructor reads `setEndpoints`.

## Testing a provider

`tests/unit/in-memory-providers.ts` holds an in-memory `ChainProvider` and `Brc20RpcProvider`, and
`tests/unit/chain-providers.test.ts` runs an inscription and a send-to-OP_RETURN dry run against
them with `fetch` stubbed to throw. They make a starting point for testing your own provider
offline.
