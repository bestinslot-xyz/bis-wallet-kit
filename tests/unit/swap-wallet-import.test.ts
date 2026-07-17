import { bls12_381 } from '@noble/curves/bls12-381.js'
import { assert, beforeEach, describe, expect, it } from 'vitest'
import {
  generateAndStoreSwapWallet,
  getSwapWalletFromDB,
  importSwapWallet,
} from '../../src/core/bis_swap.ts'
import { clearWalletInfo, deleteSwapWalletInfo, readSwapWalletInfo } from '../../src/core/store.ts'
import { wallet } from '../../src/node.ts'

// Drives the real derivation and storage paths (#45). The local WIF provider signs
// offline and store.ts falls back to an in-memory DB outside the browser, so no
// network, wallet extension or IndexedDB is needed — nothing here is mocked.

// Fixed test vector, shared with local-wallet.test.ts. Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const ADDRESS = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'

// An arbitrary but valid Fr scalar, standing in for a code saved from another browser.
const OTHER_CODE = `0x${'11'.repeat(32)}`

beforeEach(async () => {
  // signet, so getSignatureRequestText() resolves; the WIF is testnet and signet
  // shares testnet's address params.
  await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
  await deleteSwapWalletInfo(ADDRESS)
})

describe('importSwapWallet', () => {
  it('restores a wallet that derivation would have produced', async () => {
    // The rescue this exists for: the code is saved, the wallet is gone from
    // storage, and derivation is assumed to no longer reproduce it.
    const original = await generateAndStoreSwapWallet()
    await deleteSwapWalletInfo(ADDRESS)
    assert.equal(await getSwapWalletFromDB(), null)

    const imported = await importSwapWallet(original.swapPrivkey)

    // The pubkey is re-derived from the code, not carried by it — so a restored
    // wallet is byte-for-byte the wallet the sequencer has on file.
    assert.deepEqual(imported, original)
    assert.deepEqual(await getSwapWalletFromDB(), original)
  })

  it('binds the imported wallet to the connected ordinals address', async () => {
    const imported = await importSwapWallet(OTHER_CODE)

    assert.equal(imported.bitcoinAddress, ADDRESS)
    // Stored under the connected address, so the existing read path finds it.
    assert.deepEqual(await readSwapWalletInfo(ADDRESS), imported)
  })

  it('accepts a code with or without the 0x prefix, and normalises it', async () => {
    const imported = await importSwapWallet('11'.repeat(32))

    assert.equal(imported.swapPrivkey, OTHER_CODE)
  })

  it('tolerates whitespace and uppercase around a pasted code', async () => {
    // 0x0A0A… rather than 0xABAB…: the latter exceeds the Fr order and is a
    // legitimately invalid key, so it would not exercise the normalising here.
    const imported = await importSwapWallet(`  0x${'0A'.repeat(32)}\n`)

    assert.equal(imported.swapPrivkey, `0x${'0a'.repeat(32)}`)
  })

  it('throws when no ordinals wallet is connected', async () => {
    clearWalletInfo()

    await expect(importSwapWallet(OTHER_CODE)).rejects.toThrow(/Ordinals wallet address not found/)
  })
})

describe('importSwapWallet validates before storing', () => {
  // A mistyped code silently replacing a working wallet is the bad trade this
  // guards. Every case below must leave storage exactly as it was.
  const REJECTED: Array<[string, string]> = [
    ['empty', ''],
    ['not hex', 'not-a-security-code'],
    ['too short', `0x${'ab'.repeat(31)}`],
    ['too long', `0x${'ab'.repeat(33)}`],
    ['odd length', `0x${'a'.repeat(63)}`],
    ['a stray character mid-code', `0x${'ab'.repeat(31)}az`],
  ]

  for (const [name, code] of REJECTED) {
    it(`rejects ${name} without touching storage`, async () => {
      const stored = await generateAndStoreSwapWallet()

      await expect(importSwapWallet(code, { overwrite: true })).rejects.toThrow(
        /Invalid security code/,
      )
      assert.deepEqual(await getSwapWalletFromDB(), stored)
    })
  }

  it('rejects a zero scalar, which has no usable key', async () => {
    await expect(importSwapWallet(`0x${'00'.repeat(32)}`)).rejects.toThrow(/Not a valid swap key/)
    assert.equal(await getSwapWalletFromDB(), null)
  })

  it('rejects a scalar at or above the BLS field order', async () => {
    // r itself, and an all-ones code — both out of range for an Fr scalar.
    const order = `0x${bls12_381.fields.Fr.ORDER.toString(16).padStart(64, '0')}`
    await expect(importSwapWallet(order)).rejects.toThrow(/Not a valid swap key/)
    await expect(importSwapWallet(`0x${'ff'.repeat(32)}`)).rejects.toThrow(/Not a valid swap key/)
    assert.equal(await getSwapWalletFromDB(), null)
  })
})

describe('importSwapWallet overwrite semantics', () => {
  it('replaces a different stored wallet only when asked', async () => {
    const stored = await generateAndStoreSwapWallet()

    // The destructive step is the point of an import, but it has to be requested.
    await expect(importSwapWallet(OTHER_CODE)).rejects.toThrow(/Pass \{ overwrite: true \}/)
    assert.deepEqual(await getSwapWalletFromDB(), stored)

    const imported = await importSwapWallet(OTHER_CODE, { overwrite: true })
    assert.equal(imported.swapPrivkey, OTHER_CODE)
    assert.deepEqual(await getSwapWalletFromDB(), imported)
  })

  it('re-importing the stored code is a no-op, not an error', async () => {
    const stored = await generateAndStoreSwapWallet()

    // Same key means nothing is being destroyed, so there is nothing to confirm.
    const imported = await importSwapWallet(stored.swapPrivkey)

    assert.deepEqual(imported, stored)
    assert.deepEqual(await getSwapWalletFromDB(), stored)
  })

  it('needs no overwrite when storage is empty', async () => {
    const imported = await importSwapWallet(OTHER_CODE)

    assert.equal(imported.swapPrivkey, OTHER_CODE)
  })
})

describe('imported wallets work with the existing read path', () => {
  it('feeds the pubkey the order-building paths read', async () => {
    // Every withdraw/unwrap path reads the wallet through getSwapWalletFromDB, so
    // an imported wallet needs no changes elsewhere for a rescue to work.
    const imported = await importSwapWallet(OTHER_CODE)
    const read = await getSwapWalletFromDB()

    assert.equal(read?.swapPubkey, imported.swapPubkey)
    assert.equal(read?.swapPrivkey, imported.swapPrivkey)
    assert.match(read!.swapPubkey, /^0x[0-9a-f]{512}$/)
  })
})
