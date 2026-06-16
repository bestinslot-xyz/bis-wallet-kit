import { assert, describe, it } from 'vitest'
import { memoryStorage } from '../../src/core/storage.ts'
import { getNetwork, setNetwork } from '../../src/core/store-network.ts'
import { deleteSwapWalletInfo, readSwapWalletInfo, saveSwapWalletInfo } from '../../src/core/store.ts'
import { getBitcoinNetwork } from '../../src/lib/bitcoin.ts'

describe('memoryStorage', () => {
  it('gets, sets and removes values', () => {
    const store = memoryStorage()
    assert.equal(store.get('k'), null)
    store.set('k', 'v')
    assert.equal(store.get('k'), 'v')
    store.set('k', 'v2')
    assert.equal(store.get('k'), 'v2')
    store.remove('k')
    assert.equal(store.get('k'), null)
  })

  it('isolates separate instances', () => {
    const a = memoryStorage()
    const b = memoryStorage()
    a.set('x', '1')
    assert.equal(b.get('x'), null)
  })
})

describe('network store', () => {
  it('defaults to mainnet and is settable', () => {
    assert.equal(getNetwork(), 'mainnet')
    setNetwork('signet')
    assert.equal(getNetwork(), 'signet')
  })

  it('maps mainnet to the bitcoin network and others to testnet params', () => {
    setNetwork('mainnet')
    assert.equal(getBitcoinNetwork().bech32, 'bc')
    setNetwork('signet')
    assert.equal(getBitcoinNetwork().bech32, 'tb')
    setNetwork('testnet')
    assert.equal(getBitcoinNetwork().bech32, 'tb')
  })
})

describe('swap wallet store (node / no-IndexedDB fallback)', () => {
  const addr = 'tb1pswapstoretest'

  it('encrypts, persists, and reads back a swap wallet in node', async () => {
    await saveSwapWalletInfo({ bitcoinAddress: addr, swapPubkey: '0xabc', swapPrivkey: '0x1122334455' })
    const back = await readSwapWalletInfo(addr)
    assert.equal(back?.bitcoinAddress, addr)
    assert.equal(back?.swapPubkey, '0xabc')
    assert.equal(back?.swapPrivkey, '0x1122334455')
  })

  it('returns null for an unknown address and after delete', async () => {
    assert.equal(await readSwapWalletInfo('tb1pnope'), null)
    await deleteSwapWalletInfo(addr)
    assert.equal(await readSwapWalletInfo(addr), null)
  })
})
