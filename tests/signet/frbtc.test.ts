import process from 'node:process'
import { assert, describe, it } from 'vitest'
import { balances, brc20, wallet } from '../../src/node.ts'
import { connectSignetWallet, env } from './_helpers.ts'

/**
 * frBTC held directly by the wallet's BRC2.0 address: the balance read, fee quotes, and (with
 * SIGNET_EXECUTE=1) a real wrap followed by an unwrap of the same amount back to the payment address.
 *
 * Optional env (in .env.signet):
 *   SIGNET_FRBTC_SATS   default 2000 (sats to wrap, then unwrap)
 *   SIGNET_FEE_RATE     default 2 (sats/vByte)
 */

const HAS_WIF = Boolean(process.env.PRIVATE_KEY_WIF)
const FEE_RATE = Number(process.env.SIGNET_FEE_RATE ?? '2')

async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  label: string,
  timeoutMs = 45 * 60_000
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (done(value)) return value
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    console.warn(`waiting for ${label}… (${elapsed}s)`)
    await new Promise(resolve => setTimeout(resolve, 20_000))
  }
}

/** Waits for the BRC2.0 receipt of a call inscription and fails when the call reverted. */
async function expectCallSucceeded(inscriptionId: string, label: string) {
  const receipt = await pollUntil(
    async () => {
      const res = await fetch('https://rpc-signet.brc20.build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'brc20_getTxReceiptByInscriptionId',
          params: [inscriptionId],
        }),
      }).catch(() => null)
      return ((await res?.json().catch(() => null))?.result ?? null) as {
        status: string
        gasUsed: string
      } | null
    },
    r => r != null,
    `${label} receipt`
  )
  console.warn(`${label}: status ${receipt!.status}, gasUsed ${BigInt(receipt!.gasUsed)}`)
  assert.equal(receipt!.status, '0x1', `${label} reverted on BRC2.0`)
}

describe('frBTC on the BRC2.0 address (signet)', () => {
  it('uses the frBTC contract the swap treats as WBTC', async () => {
    await wallet.setNetwork('signet')
    if (env.wbtcToken) assert.equal(brc20.getFrBtcAddress(), env.wbtcToken.toLowerCase())
  })

  it.skipIf(!HAS_WIF)('reads the BRC2.0 frBTC balance of the ordinals address', async () => {
    await connectSignetWallet()
    const balance = await balances.getFrBtcBalanceOfAddress(wallet.getOrdinalsWallet()!.address!)
    console.warn(`BRC2.0 frBTC balance: ${balance} sats`)
    assert.isTrue(balance >= 0n)
  })

  it.skipIf(!HAS_WIF)('quotes a wrap with the wrapped amount as a payment', async () => {
    await connectSignetWallet()
    const quote = await brc20.wrapBtcToBrc20Prog({ amount: 2000n, feeRate: FEE_RATE, dryRun: true })
    assert.equal(quote.paymentSats, 2000)
    assert.equal(quote.walletPrompts, 2)
    assert.equal(quote.totalSats, quote.minerFeeSats + quote.postageSats + quote.paymentSats)
  })

  it.skipIf(!HAS_WIF || !env.execute)(
    'wraps BTC to the BRC2.0 address, then unwraps it back to BTC',
    { timeout: 120 * 60_000 },
    async () => {
      const amount = BigInt(process.env.SIGNET_FRBTC_SATS ?? '2000')
      await connectSignetWallet()
      const ordinals = wallet.getOrdinalsWallet()!.address!
      const payment = wallet.getPaymentWallet()!.address!
      const start = await balances.getFrBtcBalanceOfAddress(ordinals)
      console.warn(`start BRC2.0 frBTC: ${start}`)

      const wrapped = await brc20.wrapBtcToBrc20Prog({ amount, feeRate: FEE_RATE, dryRun: false })
      console.warn(`wrap txids: ${wrapped.txIds.join(', ')}`)
      await expectCallSucceeded(wrapped.call.inscriptionId, 'wrap')
      const afterWrap = await pollUntil(
        () => balances.getFrBtcBalanceOfAddress(ordinals),
        b => b > start,
        'frBTC from the wrap'
      )
      console.warn(`after wrap: ${afterWrap} (+${afterWrap - start})`)

      const unwrapped = await brc20.unwrapBtcFromBrc20Prog({
        amount,
        recipient: payment,
        feeRate: FEE_RATE,
        dryRun: false,
      })
      console.warn(`unwrap txids: ${unwrapped.txIds.join(', ')}`)
      await expectCallSucceeded(unwrapped.call.inscriptionId, 'unwrap')
      const afterUnwrap = await pollUntil(
        () => balances.getFrBtcBalanceOfAddress(ordinals),
        b => b <= afterWrap - amount,
        'frBTC burned by the unwrap'
      )
      console.warn(`after unwrap: ${afterUnwrap}`)
      assert.equal(afterUnwrap, afterWrap - amount)
    }
  )
})
