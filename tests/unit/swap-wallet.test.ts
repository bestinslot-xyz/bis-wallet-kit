import type { BISProvider } from '../../src/provider/api.ts'
import { assert, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureSwapWallet,
  generateAndStoreSwapWallet,
  getSwapWalletSecurityCode,
} from '../../src/core/bis_swap.ts'
import { registerProvider } from '../../src/core/providers.ts'
import { clearWalletInfo, deleteSwapWalletInfo } from '../../src/core/store.ts'
import { wallet } from '../../src/node.ts'
import { LOCAL } from '../../src/provider/local.ts'

// Drives the real derivation, storage and signing paths (#44). The local WIF
// provider signs offline and store.ts falls back to an in-memory DB outside the
// browser, so this needs no network, no wallet extension and no IndexedDB — the
// only thing stubbed is a counter wrapped around the provider's signing, which is
// what "does it prompt again?" actually means here.

// Fixed test vector, shared with local-wallet.test.ts. Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const ADDRESS = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'

let signCount = 0

// A pass-through provider that counts the deterministic signing prompts. Every
// prompt here is a wallet popup for a real user, so the count is the whole point.
const countingLocal: BISProvider = {
  ...LOCAL,
  signMessageDeterministic: async (message: string) => {
    signCount++
    return LOCAL.signMessageDeterministic(message)
  },
}

beforeEach(async () => {
  registerProvider('local', countingLocal)
  // signet, so getSignatureRequestText() resolves; the WIF is testnet and signet
  // shares testnet's address params.
  await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
  await deleteSwapWalletInfo(ADDRESS)
  signCount = 0
})

describe('ensureSwapWallet', () => {
  it('creates on first call, reporting created: true', async () => {
    const result = await ensureSwapWallet()

    assert.equal(result.created, true)
    assert.equal(result.wallet.bitcoinAddress, ADDRESS)
    assert.match(result.wallet.swapPrivkey, /^0x[0-9a-f]{64}$/)
    assert.equal(signCount, 2) // the deterministic-mismatch check, kept deliberately
  })

  it('returns the stored wallet without signing again, reporting created: false', async () => {
    const first = await ensureSwapWallet()
    signCount = 0

    const second = await ensureSwapWallet()

    assert.equal(second.created, false)
    assert.equal(signCount, 0) // the fix: a second connect prompts for nothing
    assert.deepEqual(second.wallet, first.wallet)
  })

  it('stays quiet across repeated calls', async () => {
    await ensureSwapWallet()
    signCount = 0

    for (let i = 0; i < 3; i++) {
      assert.equal((await ensureSwapWallet()).created, false)
    }
    assert.equal(signCount, 0)
  })

  it('adopts a wallet that createSwapWallet stored', async () => {
    // The idempotency has to see wallets created through the old entry point too,
    // or a consumer migrating to ensureSwapWallet would re-prompt once more.
    const created = await generateAndStoreSwapWallet()
    signCount = 0

    const result = await ensureSwapWallet()

    assert.equal(result.created, false)
    assert.equal(signCount, 0)
    assert.equal(result.wallet.swapPubkey, created.swapPubkey)
  })

  it('throws when no ordinals wallet is connected', async () => {
    clearWalletInfo()

    // Guards the same precondition generateAndStoreSwapWallet checks, so the
    // existence check can never read against an empty address.
    await expect(ensureSwapWallet()).rejects.toThrow(/Ordinals wallet address not found/)
    assert.equal(signCount, 0)
  })
})

describe('getSwapWalletSecurityCode', () => {
  it('returns null when no swap wallet is stored', async () => {
    assert.equal(await getSwapWalletSecurityCode(), null)
  })

  it('returns the stored code without signing again', async () => {
    const { wallet: created } = await ensureSwapWallet()
    signCount = 0

    const code = await getSwapWalletSecurityCode()

    assert.equal(code, created.swapPrivkey)
    assert.equal(signCount, 0) // "view my code again" must not prompt
  })

  it('hands out the code alone, not the wallet record', async () => {
    await ensureSwapWallet()
    const code = await getSwapWalletSecurityCode()

    // Purpose-named: a string, so there is no pubkey/address to leak through it.
    assert.equal(typeof code, 'string')
  })
})

describe('createSwapWallet is unchanged', () => {
  it('still re-derives and re-prompts on every call', async () => {
    // ensureSwapWallet is additive: the existing entry point keeps its old
    // behaviour and its old return shape for consumers already on it.
    const first = await generateAndStoreSwapWallet()
    signCount = 0

    const second = await generateAndStoreSwapWallet()

    assert.equal(signCount, 2)
    assert.deepEqual(second, first) // deterministic, so the same wallet comes back
  })
})
