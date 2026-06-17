import { assert, beforeAll, describe, expect, it } from 'vitest'
import { wallet } from '../../src/node.ts'
import { connectSignetWallet } from './_helpers.ts'

describe('wallet (signet)', () => {
  let address: string

  beforeAll(async () => {
    const w = await connectSignetWallet()
    address = w.address
  })

  it('exposes the connected session', () => {
    const session = wallet.getSession()
    assert.equal(session?.provider, 'local')
    assert.equal(session?.wallets[0]?.address, address)
  })

  it('returns the same wallet for payment and ordinals (single-wallet provider)', () => {
    assert.equal(wallet.getPaymentWallet()?.address, address)
    assert.equal(wallet.getOrdinalsWallet()?.address, address)
  })

  it('reports the current network', () => {
    assert.equal(wallet.getNetwork(), 'signet')
  })

  it('returns the cardinal (spendable) balance', async () => {
    const sats = await wallet.getCardinalBalance(address)
    assert.ok(typeof sats === 'number')
    assert.ok(sats >= 0)
  })

  it('returns full balance details', async () => {
    const details = await wallet.getAllBalanceDetails(address)
    assert.ok(details)
  })

  it('signs and backend-verifies a message', async () => {
    const sig = await wallet.signMessage('gm', 'payment')
    assert.ok(typeof sig === 'string' && sig.length > 0)
  })

  it('signs and locally-verifies a message', async () => {
    const sig = await wallet.signMessageLocalVerify('gm', 'payment')
    assert.ok(typeof sig === 'string' && sig.length > 0)
  })

  it('does not support sendBTC on the local wallet', async () => {
    await expect(wallet.sendBTC(1000, address)).rejects.toThrow(/not supported/i)
  })
})
