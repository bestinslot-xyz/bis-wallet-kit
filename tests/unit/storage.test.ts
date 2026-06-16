import { assert, describe, it } from 'vitest'
import { memoryStorage } from '../../src/core/storage.ts'
import { getNetwork, setNetwork } from '../../src/core/store-network.ts'
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
