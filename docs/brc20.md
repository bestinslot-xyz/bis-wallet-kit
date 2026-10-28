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

## Send to another address

A sender can hold a ticker in two places: the base BRC-20 balance and the BRC2.0 balance. The two
composite sends fill a payment from both and deliver it in the form the recipient asks for. Each one
signs its steps as a single chain, where every step's commit spends an output of the previous step's
send, and broadcasts the chain at the end. The steps never compete for a UTXO, and on-chain they
confirm and index in order.

### Recipient receives BRC-20

```ts
const res = await brc20.sendAsBrc20({
  tick: 'ordi',
  fromBrc20Amount: '5', // from the base BRC-20 balance, decimal string, may be '0'
  fromProgAmount: '2.5', // from the BRC2.0 balance, decimal string, may be '0'
  recipient: 'bc1p…',
  feeRate: 2,
  dryRun: false,
  onSignRequest: ({ step, total }) => showProgress(`Sign ${step} of ${total}`),
})
// res.brc20Transfer / res.progWithdraw: { commitTxId, revealTxId, sendTxId, inscriptionId } or null
// res.txIds: every txid in chain order
```

- To another address, `fromProgAmount` is first a `brc20-module` withdraw inscription sent to the
  sender's own ordinals address, which moves it into the sender's base balance. Then one BRC-20
  transfer inscription of `fromBrc20Amount + fromProgAmount` goes to `recipient`. Exchanges and
  wallets credit incoming BRC-20 only from transfer inscriptions, so the recipient never receives
  the withdraw itself.
- To the sender's own ordinals address, the withdraw goes straight to it and the transfer carries
  only `fromBrc20Amount`.

### Recipient receives BRC2.0

```ts
const res = await brc20.sendAsBrc20Prog({
  tick: 'ordi',
  contractAddress: '0x…', // the token's BRC2.0 contract
  topUpFromBrc20: '1', // deposited from the base balance first, decimal string, may be '0'
  amount: 3n * 10n ** 18n, // total the recipient receives, bigint in 18 decimals (as in swap.deposit)
  recipient: 'bc1p…',
  feeRate: 2,
  dryRun: false,
})
// res.progDeposit (or null) and res.progTransfer: { commitTxId, revealTxId, sendTxId, inscriptionId }
```

- `topUpFromBrc20` is deposited into the **sender's** BRC2.0 balance (a transfer inscription sent to
  `OP_RETURN "BRC20PROG"`). It must not exceed `amount`.
- Then an ERC-20 `transfer(recipientEvm, amount)` call on `contractAddress` moves `amount` to
  `getEvmAddressFromBitcoinAddress(recipient)`. The call is inscribed from the ordinals identity,
  which owns the sender's BRC2.0 balance, and its commit spends the deposit's output, so the deposit
  is indexed first.
- BRC2.0 grants each call `content bytes × 12000` gas. The transfer inscription is about 150 bytes,
  which covers the 100,000-gas ceiling the kit reserves for an ERC-20 transfer many times over.

The caller sizes the split from the sender's balances (`balances.getBaseBRC20BalanceOfAddress`,
`balances.getBRC20ProgBalanceOfAddress`).

### Fee quote

`dryRun: true` builds the same chain without signing or broadcasting and returns a quote for a
review screen:

```ts
const quote = await brc20.sendAsBrc20({ ...args, dryRun: true })
// {
//   totalSats,      // minerFeeSats + postageSats + paymentSats
//   minerFeeSats,   // commit + reveal + send fees of every step
//   postageSats,    // sats left on target outputs: recipient dust, or 1 per OP_RETURN
//   paymentSats,    // sats paid to extra outputs (the frBTC signer below; 0 for these sends)
//   walletPrompts,  // 2 per step
//   feeRate,
//   steps: [{ step: 'brc20Transfer' | 'progWithdraw' | 'progDeposit' | 'progTransfer'
//                 | 'frBtcWrap' | 'frBtcUnwrap',
//             minerFeeSats, postageSats, paymentSats, walletPrompts }],
// }
```

`onSignRequest` fires before each wallet prompt of a real send with `{ step, total }`; `total`
matches the quote's `walletPrompts` (2 per step).

## Wrap and unwrap BTC on the BRC2.0 address

frBTC is Subfrost's wrapped BTC on BRC2.0, an ERC-20 with 8 decimals (1 frBTC unit = 1 sat). The
wallet's BRC2.0 address can hold it directly and wrap or unwrap it with no smart wallet involved.
This is separate from `swap.wrapBtc` / `swap.unwrapBtc`, which move BTC in and out of the swap smart
wallet.

```ts
brc20.getFrBtcAddress() // frBTC contract on the selected network (mainnet, signet)

const ordinals = wallet.getOrdinalsWallet()!.address!
const held = await balances.getFrBtcBalanceOfAddress(ordinals) // bigint sats

// BTC → frBTC held by the ordinals address's BRC2.0 address
await brc20.wrapBtcToBrc20Prog({ amount: 10_000n, feeRate: 2, dryRun: false })

// frBTC → BTC paid to any Bitcoin address
await brc20.unwrapBtcFromBrc20Prog({
  amount: 10_000n,
  recipient: 'bc1p…',
  feeRate: 2,
  dryRun: false,
})
// both return { call: { commitTxId, revealTxId, sendTxId, inscriptionId }, txIds }
```

Each is one call inscription on the frBTC contract, sent to `OP_RETURN "BRC20PROG"` from the
ordinals identity. The send transaction also pays the frBTC signer (read from the contract's
`getSignerAddress()`) at vout 1:

- **Wrap** calls `wrap()` and pays `amount` sats to the signer. The contract mints the frBTC to the
  caller, less its fee (`premium()` on the contract: 0 on signet, non-zero on mainnet). The quote's
  `paymentSats` is the BTC sent. `amount` is at least 546 sats.
- **Unwrap** calls `unwrap2(amount, 1, recipientScript)` and pays a 546-sat marker to the signer.
  The contract burns the frBTC at once and queues the payment, which the signer pays out to
  `recipient` in a later Bitcoin transaction. The kit reads the BRC2.0 balance first and refuses an
  `amount` above it, so a quote or send fails before anything is signed.
- The signer pays its own miner fee out of each payout, so `recipient` receives `amount` minus that
  fee. The fee follows the network fee rate (recent signet payouts paid about 15,000 sats), so an
  unwrap that small leaves little or nothing to pay out. Unwrap well above it.

Both calls read their own send transaction through the BRC2.0 tx-details precompile, which charges
400,000 gas plus 400,000 per input. The kit pads each call inscription to cover a send of up to 8
inputs (about 4M gas, roughly 85 vB of padding) and refuses a send that would spend more, before
broadcast. A call short of gas reverts on BRC2.0 while its Bitcoin transactions still confirm, so
the BTC paid to the signer would not be credited.

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
