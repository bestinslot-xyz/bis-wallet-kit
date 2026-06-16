# Inscriptions

The `mint` namespace creates ordinal inscriptions and estimates their fees. The
top-level builders turn content into an `InscriptionDetails`.

## Build inscription content

```ts
import { brc20MintInscription, delegateInscription, jsonInscription, textInscription } from '@bestinslot/wallet-kit'

const text = textInscription('hello world')          // mime text/plain
const json = jsonInscription({ p: 'brc-20', op: 'deploy', tick: 'abcd', max: 1000, lim: 10 })
const delegate = delegateInscription('abc…i0')       // delegate to another inscription
const mintIns = brc20MintInscription('abcd', 1000n)   // {"p":"brc-20","op":"mint","tick":"abcd","amt":"1000"}
```

`brc20MintInscription(ticker, amount)` is a convenience over `jsonInscription`
for the common BRC-20 mint; pass the result to `mint.inscribe`. The `amount` is
in the ticker's own decimals and is serialised as a string.

## Inscribe

```ts
import { mint, textInscription } from '@bestinslot/wallet-kit'

const result = await mint.inscribe(
  textInscription('gm'),
  2,      // feeRate, sats/vByte
  null,   // postage in sats, or null for default dust
  false,  // dryRun — true returns tx details without broadcasting
)
// result: { commitTxId, signedCommitTxHex, revealTxId, signedRevealTxHex, inscriptionId, postage, secret }
```

Set `dryRun: true` to get the same shape back without touching the network — handy
for previews and tests.

### Multiple inscriptions in one commit

```ts
const result = await mint.inscribeMultiple(
  [textInscription('first'), textInscription('second')],
  2,
  null,
  false,
)
// result.inscriptionIds: string[]
```

### Child of a parent (provenance)

```ts
await mint.inscribeWithParent(child, parentInscriptionId, feeRate, postage, dryRun)
```

## Estimate fees first

```ts
const fees = await mint.getInscribeFee(textInscription('gm'), 2, null)
// fees: { totalFee, commitFee, revealFee, postage, secret }

const multiFees = await mint.getInscribeMultipleFee([a, b], 2, null)
```

All inscribe / fee functions take an optional final `paymentOpts`
(`{ paymentAddress, paymentAmount }`) when payment should come from a separate
address.
