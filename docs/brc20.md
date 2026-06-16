# BRC-2.0 programmable

The `brc20` namespace covers the BRC-2.0 programmable module: moving base BRC-20
balances in and out of the programmable layer, and calling smart contracts.

The top-level helpers map a Bitcoin identity to its EVM-style address used by the
programmable layer:

```ts
import { getEvmAddressFromBitcoinAddress, getEvmAddressFromPkScript } from '@bestinslot/wallet-kit'

const evm = getEvmAddressFromBitcoinAddress('bc1p…') // 0x… (last 20 bytes of keccak256(pkscript))
const evm2 = getEvmAddressFromPkScript('5120…')
```

> These derive from the **current network** (`wallet.setNetwork(...)`), since the
> address → pkscript step is network-specific.

## Deposit base BRC-20 into the programmable layer

```ts
import { brc20 } from '@bestinslot/wallet-kit'

const result = await brc20.depositToBrc20Prog(
  'atat',  // ticker
  '1',     // amount (string)
  2,       // feeRate, sats/vByte
  null,    // postage or null
  true,    // dryRun
)
// result includes commitTxId, revealTxId, signed hexes, and sendToOpReturnTxId
```

## Withdraw back to a Bitcoin address

```ts
const result = await brc20.withdrawFromBrc20Prog(
  'atat',
  '1',
  targetBitcoinAddress,
  2,       // feeRate
  null,    // postage
  true,    // dryRun
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
  postage,   // or null
  dryRun,
  paymentOpts, // optional
  walletType,  // optional 'ordinals' | 'payment' | 'all'
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
  dryRun,
)
```

Every function takes a final optional `paymentOpts`
(`{ paymentAddress, paymentAmount }`); the contract-call functions also take an
optional `walletType`. Use `dryRun: true` to assemble transactions without
broadcasting.
