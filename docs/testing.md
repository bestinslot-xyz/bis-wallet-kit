# Testing

There are two kinds of tests:

| Suite | Command | Needs network / secrets? |
|-------|---------|--------------------------|
| **Unit** (`tests/unit/`) | `pnpm test` | No — offline, deterministic, the CI default |
| **Signet integration** (`tests/signet/`) | `pnpm test:signet` | Yes — live signet backend + a funded WIF |
| **Mainnet integration** (`tests/mainnet/`) | `pnpm test:mainnet` | Yes — live mainnet backend |

## Unit tests

```bash
pnpm test
```

Run with no setup. They cover the parts that don't touch the network:

- **Public API surface** (`api-surface.test.ts`) — asserts every exported
  function exists under the right namespace. This is the cheapest guard against a
  rename or dropped export breaking consumers.
- **Encoding & builders** (`encoding.test.ts`) — `base64ToHex` / `hexToBase64`,
  `createUnsecuredToken`, and the inscription builders.
- **EVM & pair address** (`evm-and-pair.test.ts`) — `getEvmAddressFrom*` and the
  Uniswap pair address, checked against golden vectors.
- **Storage & network** (`storage.test.ts`) — in-memory store and network params.
- **Local wallet** (`local-wallet.test.ts`) — WIF → address derivation
  (p2wpkh / p2tr), session storage, and offline BIP-322 signing.

### About the golden vectors

The EVM/pair/address vectors were computed **independently** (raw
`bitcoinjs-lib` / `web3` / `ethers`), not by running the library, so the tests
verify behaviour rather than merely mirroring the implementation. The local
wallet uses a fixed throwaway key (`0x1111…11`, testnet) — never fund it.

## Integration tests

These hit live backends and sign real transactions, so they need a wallet key.
Most assertions use `dryRun` so they assemble (but don't broadcast) transactions.

1. Create the env file for the network you're testing:

   `.env.signet` (for `pnpm test:signet`):
   ```
   PRIVATE_KEY_WIF=<a signet WIF with a little balance>
   ```

   `.env.mainnet` (for `pnpm test:mainnet`):
   ```
   PRIVATE_KEY_WIF=<a mainnet WIF>
   ```

   `.env*` files are gitignored — never commit a key.

2. Run:
   ```bash
   pnpm test:signet
   pnpm test:mainnet
   ```

Tests that depend on a known token guard themselves with `it.skipIf(...)`, so
they skip rather than fail when a fixture isn't configured.

## Adding tests

Prefer the unit suite. If logic can run without the network — encoding, address
derivation, validation, transaction assembly under `dryRun` — put it in
`tests/unit/` so it runs in CI for every contributor. Reserve the signet/mainnet
suites for things that genuinely require a live backend.
