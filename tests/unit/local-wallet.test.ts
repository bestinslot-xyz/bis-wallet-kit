import { assert, describe, expect, it } from 'vitest'
import { wallet } from '../../src/node.ts'

// Fixed test vector (private key 0x1111...11, testnet). Addresses derived
// independently with bitcoinjs. Never use this key for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const P2WPKH = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const P2TR = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'

describe('local wallet provider', () => {
  it('derives a p2wpkh address from a WIF', async () => {
    const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2wpkh', 'unisat')
    assert.equal(w.address, P2WPKH)
    assert.equal(w.purpose, 'all')
    assert.ok(w.pubkey)
  })

  it('derives a p2tr address from a WIF', async () => {
    const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    assert.equal(w.address, P2TR)
  })

  it('stores a retrievable local session', async () => {
    await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    const session = wallet.getSession()
    assert.equal(session?.provider, 'local')
    assert.equal(session?.wallets[0]?.address, P2TR)
  })

  it('rejects an unsupported wallet type', async () => {
    await expect(
      wallet.connectLocalWallet(WIF, 'testnet', 'p2sh' as any, 'unisat'),
    ).rejects.toThrow(/Invalid wallet type/)
  })

  it('rejects an unsupported wallet source', async () => {
    await expect(
      wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'phantom' as any),
    ).rejects.toThrow(/Invalid wallet source/)
  })

  it('signs a message that verifies offline (bip322)', async () => {
    await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    const sig = await wallet.signMessageLocalVerify('gm', 'payment')
    assert.ok(typeof sig === 'string' && sig.length > 0)
  })
})

describe('createWallet (local key generation)', () => {
  it('generates a p2wpkh wallet with a wif, address, pubkey and purpose', async () => {
    const w = await wallet.createWallet('testnet', 'p2wpkh')
    assert.ok(w.wif && typeof w.wif === 'string')
    assert.match(w.address, /^tb1q/)
    assert.ok(w.pubkey)
    assert.equal(w.purpose, 'all')
  })

  it('generates a p2tr wallet', async () => {
    const w = await wallet.createWallet('testnet', 'p2tr')
    assert.match(w.address, /^tb1p/)
  })

  it('generates a wif that re-imports to the same address (round-trip)', async () => {
    const generated = await wallet.createWallet('testnet', 'p2wpkh')
    const reimported = await wallet.connectLocalWallet(generated.wif, 'testnet', 'p2wpkh', 'unisat')
    assert.equal(reimported.address, generated.address)
    assert.equal(reimported.pubkey, generated.pubkey)
  })

  it('generates a distinct key on each call', async () => {
    const a = await wallet.createWallet('testnet', 'p2wpkh')
    const b = await wallet.createWallet('testnet', 'p2wpkh')
    assert.notEqual(a.wif, b.wif)
    assert.notEqual(a.address, b.address)
  })

  it('connects the generated wallet as a retrievable session', async () => {
    const w = await wallet.createWallet('testnet', 'p2tr')
    const session = wallet.getSession()
    assert.equal(session?.provider, 'local')
    assert.equal(session?.wallets[0]?.address, w.address)
  })
})
