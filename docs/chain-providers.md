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
  inscriptionUtxo?: (address: string, inscriptionId: string) => Promise<OrdinalUtxo | null> // optional
  balance: (address: string) => Promise<ChainBalance>
  txHex: (txid: string) => Promise<string>
  testMempoolAccept: (txHexes: string[]) => Promise<MempoolAcceptResult[]>
  broadcast: (txHexes: string[]) => Promise<string[]> // txids
}
```

| Method              | Returns                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cardinalUtxos`     | The address's unspent outputs that carry no inscriptions and no runes. These fund every transaction the kit builds.                     |
| `ordinalUtxos`      | The address's unspent outputs that carry inscriptions. Used to find an inscription when the provider has no `inscriptionUtxo`.          |
| `inscriptionUtxo`   | Optional. The address's unspent output carrying one inscription, or `null`. Finds an inscription to send or use as a parent.            |
| `balance`           | The address's confirmed balance, and the amount unconfirmed transactions add to it (negative when they spend from it).                  |
| `txHex`             | The raw transaction, hex encoded. The kit reads the transactions that created the outputs it spends.                                    |
| `testMempoolAccept` | One verdict per transaction, in order. Later transactions in the list may spend outputs of earlier ones, as `testmempoolaccept` allows. |
| `broadcast`         | The txids of the broadcast transactions, in order. The list is a chain (commit, reveal, send), so broadcast them in the order given.    |

Every method throws when it cannot answer.

`inscriptionUtxo` answers in one lookup whatever else the address holds, and its `inscription_ids` /
`satpoints` may list just the requested inscription. Without it, the kit searches the address's
`ordinalUtxos`, whose cost grows with the number of inscriptions the address holds.

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

The one exception is an output whose only inscriptions are used BRC-20 ones (see
[Spending used BRC-20 inscriptions](#spending-used-brc-20-inscriptions)). A provider returns it with
`inscription_ids` and `satpoints` set, so the kit knows where those inscriptions sit.

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

`BisChainProvider.inscriptionUtxo` reads the indexer's `inscription_utxo/<address>/<inscriptionId>`
route. An indexer that answers that route with HTTP 404 is searched through `ordinal_utxos` instead.

## Spending used BRC-20 inscriptions

A BRC-20 mint inscription does its work when it is inscribed, and a transfer inscription when it is
first sent. After that, moving them has no BRC-20 effect, so the sats under them are spendable BTC.
`new BisChainProvider({ includeUsedBrc20: true })` asks `cardinal_utxos` for these outputs too
(`?include_used_brc20=1`). Each one comes with `inscription_ids`, `satpoints` and
`brc20_inscriptions` (the kind, ticker and amount of each inscription), which an app can use to tell
the user before they spend it.

```ts
wallet.setProviders({
  mainnet: { chain: new BisChainProvider({ includeUsedBrc20: true }) },
  signet: { chain: new BisChainProvider({ includeUsedBrc20: true }) },
})
```

The transaction builders keep those inscriptions' sats out of every output that does not pay the
change address. That matters most for a commit: the reveal inscribes on the commit output's first
sat, and BRC-20 ignores an inscription made on a sat that already carries one. It also keeps them
out of recipients, OP_RETURNs and the swap handler.

- **Only when needed, and one at a time.** A transaction spends an output with used inscriptions
  only when the outputs without them cannot pay for it, and then only the one with the most
  recoverable BTC (below). The outputs without inscriptions go first, so the used-inscription sats
  land in the change or the fee.
- **A set-aside output takes the rest.** When an outside output would still receive one, for example
  when a consolidated output carries an inscription on its first sat, the builder adds one output to
  the change address right before it. It is at least the dust limit and reaches past the last
  inscribed sat, so every later output starts clean. It and its fee come out of the change, and the
  builders report where each output ended up.
- **Otherwise the transaction does without them.** A set-aside output never goes where the sats of a
  forced input (the inscription a send moves) would land. When that is the only place it could go,
  the transaction is built from outputs without inscriptions alone.

The kit remembers where the inscriptions of its own pending transactions land, so their change and
set-aside outputs keep their inscriptions when a chained flow spends them.

### Recoverable BTC

Only the BTC after an output's last inscribed sat can be spent: the set-aside output keeps the
inscribed sats, and it is at least the dust limit. An output that is just an inscription's postage
(330 or 546 sats, as most used inscriptions sit on) gives nothing. One that a consolidation filled
with the postage of many inscriptions first and plain BTC after gives the plain BTC.

`wallet.getCardinalBalances(address)` reports what the builders can spend: `plain` (outputs without
inscriptions) and `recoverable` (from the one inscribed output a transaction would add), so an app
can offer exactly that. The spending inputs' own fees are not subtracted.

A wrap (`swap.wrapBtc`) pays the swap handler from its send, which cannot take inscribed sats. When
the BTC outside used inscriptions cannot fund the whole wrap, its commit splits the inscribed output
instead and hands the send its clean BTC as change.

## Testing a provider

`tests/unit/in-memory-providers.ts` holds an in-memory `ChainProvider` and `Brc20RpcProvider`, and
`tests/unit/chain-providers.test.ts` runs an inscription and a send-to-OP_RETURN dry run against
them with `fetch` stubbed to throw. They make a starting point for testing your own provider
offline.
