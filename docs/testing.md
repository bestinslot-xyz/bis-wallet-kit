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

Tests that depend on a fixture guard themselves with `it.skipIf(...)`, so they
skip rather than fail when it isn't configured.

### Signet fixtures (optional)

The signet suite covers more the more you configure. All of these are read from
`.env.signet`; unset ones just skip the tests that need them.

| Var | Enables |
|-----|---------|
| `PRIVATE_KEY_WIF` | everything (required) — the funded signet test wallet |
| `SIGNET_SWAP_TOKEN` | token-specific reads (decimals, balance) |
| `SIGNET_WBTC_TOKEN` | swap quotes (paired with `SIGNET_SWAP_TOKEN`) |
| `SIGNET_SWAP_PAIR` | pair reads — reserves, klines, volume, activity |
| `SIGNET_REFERRER_ID` | referral resolution + referral swap |
| `SIGNET_KNOWN_TICKER` | ticker→address + ticker balance + BRC-2.0 deposit/withdraw dry-runs (must exist on signet / be held by the wallet) |
| `SIGNET_BASE_BRC20_TOKEN` | base BRC-20 balance lookup (must be a token the wallet holds) |
| `SIGNET_PROG_TOKEN` | overrides the token address used for the wallet-agnostic prog-balance read (has a default) |
| `SIGNET_CONTRACT_ADDRESS` | BRC-2.0 smart-contract call (dry-run) |
| `SIGNET_PARENT_INSCRIPTION_ID` | parent/child inscription (dry-run) |

### Executing on signet (moving funds)

Fund-moving swap tests (`swapExactInput`/`swapExactOutput`/`addLiquidity`) are
**off by default**, even with fixtures set. To run them:

```
SIGNET_EXECUTE=1
SIGNET_SWAP_TOKEN=0x…
SIGNET_WBTC_TOKEN=0x…
SIGNET_SWAP_AMOUNT=1000     # optional, input amount (base units)
SIGNET_SLIPPAGE_BPS=100     # optional
```

These assume the sequencer settles synchronously — after a swap returns
`success`, the smart-wallet balance reflects it without waiting for a block. The
test wallet must hold enough deposited balance to cover the swaps.

### End-to-end lifecycle (signet)

`tests/signet/brc20-lifecycle.test.ts` is a single long-running test that walks
the full path — mint BRC-20 → deposit into the smart wallet → wrap BTC → add
liquidity → swap both ways → withdraw — waiting on the chain/indexer between
steps. It moves real funds and can take tens of minutes (multiple signet
blocks), so it's **off unless `SIGNET_E2E=1`** and is never part of CI.

Add to `.env.signet`:

```
SIGNET_E2E=1
PRIVATE_KEY_WIF=<funded signet WIF: BTC for fees + the BTC to wrap>
SIGNET_E2E_TICKER=<a deployed BRC-20 ticker with mint limit >= the amount>
SIGNET_E2E_TOKEN=0x…        # the programmable (EVM) token address for that ticker
SIGNET_WBTC_TOKEN=0x…       # the WBTC token address
# optional:
SIGNET_E2E_MINT_AMOUNT=1000 # ticker units
SIGNET_E2E_BTC_SATS=10000   # sats to wrap
SIGNET_E2E_FEE_RATE=2       # sats/vByte
```

Then `pnpm test:signet`. Amounts and timeouts may need tuning for your ticker on
the first run.

## Adding tests

Prefer the unit suite. If logic can run without the network — encoding, address
derivation, validation, transaction assembly under `dryRun` — put it in
`tests/unit/` so it runs in CI for every contributor. Reserve the signet/mainnet
suites for things that genuinely require a live backend.
