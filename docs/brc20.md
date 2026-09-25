# BRC-2.0 programmable

The `brc20` namespace covers the BRC-2.0 programmable module: moving base BRC-20 balances in and out
of the programmable layer, and calling smart contracts. It also exposes a set of pure builders that
**generate base BRC-20 inscription payloads** — see
[Base BRC-20 inscriptions](#base-brc-20-inscriptions) below.

The top-level helpers map a Bitcoin identity to its EVM-style address used by the programmable
layer:

```ts
import { getEvmAddressFromBitcoinAddress, getEvmAddressFromPkScript } from '@bestinslot/wallet-kit'

const evm = getEvmAddressFromBitcoinAddress('bc1p…') // 0x… (last 20 bytes of keccak256(pkscript))
const evm2 = getEvmAddressFromPkScript('5120…')
```

> These derive from the **current network** (`wallet.setNetwork(...)`), since the address → pkscript
> step is network-specific.

## Deposit base BRC-20 into the programmable layer

```ts
import { brc20 } from '@bestinslot/wallet-kit'

const result = await brc20.depositToBrc20Prog(
  'atat', // ticker
  '1', // amount (string)
  2, // feeRate, sats/vByte
  null, // postage or null
  true // dryRun
)
// result includes commitTxId, revealTxId, signed hexes, and sendToOpReturnTxId
```

## Withdraw back to a Bitcoin address

```ts
const result = await brc20.withdrawFromBrc20Prog(
  'atat',
  '1',
  targetBitcoinAddress,
  2, // feeRate
  null, // postage
  true // dryRun
)
```

## Call a smart contract

By raw calldata:

```ts
await brc20.callSmartContract(
  contractAddress,
  calldataHex,
  estimatedGas,
  gasPerVbyte,
  feeRate,
  postage, // or null
  dryRun,
  paymentOpts, // optional
  walletType // optional 'ordinals' | 'payment' | 'all'
)
```

Or by ABI + function name (calldata is encoded for you):

```ts
await brc20.callSmartContractAbi(
  contractAddress,
  abi,
  'transfer',
  [recipient, amount],
  estimatedGas,
  gasPerVbyte,
  feeRate,
  postage,
  dryRun
)
```

Every function takes a final optional `paymentOpts` (`{ paymentAddress, paymentAmount }`); the
contract-call functions also take an optional `walletType`. Use `dryRun: true` to assemble
transactions without broadcasting.

## Base BRC-20 inscriptions

These helpers are **pure builders**: they return an `InscriptionDetails` (like `jsonInscription` /
`textInscription`) that you inscribe with the [`mint` namespace](./inscriptions.md) helpers
(`inscribe`, `inscribeWithParent`). They never broadcast and never wait for blocks — you drive that.

Ticker sizing follows the BRC-20 rules:

- **4 bytes** — free to mint for all (no `self_mint`).
- **5 bytes** — self-issuance; `self_mint: "true"` is set automatically.
- **6 bytes** — namespaced
  ([proposal](https://github.com/bestinslot-xyz/brc20-proposals/blob/main/001-6-byte-namespace/index.md));
  requires a salted predeploy/reveal (see below). The ticker must match `^[A-Za-z0-9-]{6}$`.

### Deploy / mint / transfer (4- and 5-byte)

```ts
import { brc20, mint } from '@bestinslot/wallet-kit'

const deploy = brc20.deployBrc20Inscription({ tick: 'ordi', max: '21000000', lim: '1000' })
const mintOp = brc20.mintBrc20Inscription({ tick: 'ordi', amt: '1000' })
const xfer = brc20.transferBrc20Inscription({ tick: 'ordi', amt: '5' })

// Inscribe with the existing helpers:
await mint.inscribe(deploy, 2 /* feeRate */, null /* postage */, true /* dryRun */)
```

`deployBrc20Inscription` accepts `{ tick, max, lim?, dec?, selfMint? }`. A 5-byte `tick` always
emits `self_mint: "true"`; a 4-byte `tick` omits it unless you pass `selfMint: true`.

### 6-byte namespace: predeploy → deploy

`predeployInscriptions` returns **both** payloads (with a shared salt, generated for you unless you
pass one) so the flow works out of the box. Inscribe the predeploy, wait the required block delay (≥
3 blocks), then inscribe the deploy as a **child** of the predeploy inscription:

```ts
const { salt, hash, predeploy, deploy } = brc20.predeployInscriptions({
  tick: 'sixbyt', // 6 bytes, [A-Za-z0-9-]
  address: myOrdinalsAddress, // pkscript is derived on the current network and bound into the hash
  max: '21000000',
  lim: '1000',
})

// 1. Inscribe the predeploy commitment.
const pre = await mint.inscribe(predeploy, 2, null, false)

// 2. Wait ≥ 3 blocks for the predeploy to confirm and be indexed.

// 3. Inscribe the deploy as a child of the predeploy (parent goes on the 2nd input).
await mint.inscribeWithParent(deploy, pre.inscriptionId, 2, null, false)
```

`address` must be the address that will receive the deploy reveal — the commitment hash binds the
predeploy to its output script to prevent cross-wallet replay. Keep `salt` if you build the payloads
separately; the deploy must reuse the exact salt the predeploy committed to.

Lower-level helpers are also exported: `generateBrc20Salt(byteLength?)` for a random hex salt, and
`computeBrc20PredeployHash(tick, salt, pkscript)` for the raw
`double_sha256(tick + salt + pkscript)` commitment.
