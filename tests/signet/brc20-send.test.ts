import process from 'node:process'
import { assert, describe, it } from 'vitest'
import { balances, brc20, wallet } from '../../src/node.ts'

/**
 * Composite sends on signet: `brc20.sendAsBrc20` and `brc20.sendAsBrc20Prog`, each drawing on both
 * the base BRC-20 and the BRC2.0 balance, sent from the p2tr wallet to the same key's p2wpkh address
 * (a separate BRC-20 holder and EVM address). It moves real funds and waits for blocks, so it runs
 * only with SIGNET_SEND=1.
 *
 * Env (in .env.signet):
 *   SIGNET_SEND=1
 *   PRIVATE_KEY_WIF        funded signet wallet holding the ticker in both balances
 *   SIGNET_SEND_TICKER     ticker to send (default SIGNET_E2E_TICKER)
 *   SIGNET_SEND_TOKEN      its BRC2.0 contract (default SIGNET_E2E_TOKEN, else resolved from the ticker)
 *   SIGNET_SEND_AMOUNT     units taken from each balance per part (default 1)
 *   SIGNET_SEND_FEE_RATE   sats/vB (default 2)
 */

const WIF = process.env.PRIVATE_KEY_WIF
const TICKER = process.env.SIGNET_SEND_TICKER ?? process.env.SIGNET_E2E_TICKER
const TOKEN = process.env.SIGNET_SEND_TOKEN ?? process.env.SIGNET_E2E_TOKEN
const PART = process.env.SIGNET_SEND_AMOUNT ?? '1'
const FEE_RATE = Number(process.env.SIGNET_SEND_FEE_RATE ?? '2')
const ENABLED = process.env.SIGNET_SEND === '1' && !!WIF && !!TICKER

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
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    console.warn(`waiting for ${label}… ${Math.round((Date.now() - start) / 1000)}s`)
    await new Promise(resolve => setTimeout(resolve, 20_000))
  }
}

describe('brc20 composite sends (signet, moves funds)', () => {
  it.skipIf(!ENABLED)(
    'sendAsBrc20 and sendAsBrc20Prog move both balances to the recipient',
    { timeout: 120 * 60_000 },
    async () => {
      const recipient = (await wallet.connectLocalWallet(WIF!, 'signet', 'p2wpkh', 'unisat'))
        .address
      const sender = (await wallet.connectLocalWallet(WIF!, 'signet', 'p2tr', 'unisat')).address
      const tickerToken = await balances.getBRC20ProgTokenAddressOfTicker(TICKER!)
      const token = TOKEN ?? tickerToken
      const one = 10n ** 18n * BigInt(PART)
      console.warn({ sender, recipient, ticker: TICKER, token, tickerToken })

      // The backend answers an address that never held the ticker with an error, not a zero.
      const baseBalance = async (address: string) => {
        try {
          const b = await balances.getBaseBRC20BalanceOfAddress(address, token)
          return b.availableBalanceIn18Decimals
        } catch (e) {
          if (String(e).includes('No available balance')) return 0n
          throw e
        }
      }
      const read = async () => {
        const [senderBase, senderProg, recipientBase, recipientProg] = await Promise.all([
          baseBalance(sender),
          balances.getBRC20ProgBalanceOfAddress(sender, token),
          baseBalance(recipient),
          balances.getBRC20ProgBalanceOfAddress(recipient, token),
        ])
        return { senderBase, senderProg, recipientBase, recipientProg }
      }
      const start = await read()
      console.warn('start', start)
      assert.ok(start.senderBase >= 2n * one, 'sender needs 2 parts of base BRC-20')
      assert.ok(start.senderProg >= one, 'sender needs 1 part of BRC2.0')

      // 1. Recipient receives BRC-20: one part from each balance.
      const quote1 = await brc20.sendAsBrc20({
        tick: TICKER!,
        fromBrc20Amount: PART,
        fromProgAmount: PART,
        recipient,
        feeRate: FEE_RATE,
        dryRun: true,
      })
      console.warn('sendAsBrc20 quote', quote1)
      assert.equal(quote1.walletPrompts, 4)

      const prompts1: number[] = []
      const sent1 = await brc20.sendAsBrc20({
        tick: TICKER!,
        fromBrc20Amount: PART,
        fromProgAmount: PART,
        recipient,
        feeRate: FEE_RATE,
        dryRun: false,
        onSignRequest: r => prompts1.push(r.step),
      })
      console.warn('sendAsBrc20 txids', sent1)
      assert.deepEqual(prompts1, [1, 2, 3, 4])

      const afterSend1 = await pollUntil(
        read,
        b => b.recipientBase >= start.recipientBase + 2n * one,
        'recipient base BRC-20 to rise by 2 parts'
      )
      console.warn('after sendAsBrc20', afterSend1)
      assert.equal(afterSend1.senderBase, start.senderBase - one)
      assert.equal(afterSend1.senderProg, start.senderProg - one)

      // 2. Recipient receives BRC2.0: one part topped up from base, plus one part already in BRC2.0.
      // The sender's prog balance just dropped by one part, so draw the second part only if it is there.
      const fromProg = afterSend1.senderProg >= one ? one : 0n
      const amount = one + fromProg
      const quote2 = await brc20.sendAsBrc20Prog({
        tick: TICKER!,
        contractAddress: token,
        topUpFromBrc20: PART,
        amount,
        recipient,
        feeRate: FEE_RATE,
        dryRun: true,
      })
      console.warn('sendAsBrc20Prog quote', quote2)

      const sent2 = await brc20.sendAsBrc20Prog({
        tick: TICKER!,
        contractAddress: token,
        topUpFromBrc20: PART,
        amount,
        recipient,
        feeRate: FEE_RATE,
        dryRun: false,
      })
      console.warn('sendAsBrc20Prog txids', sent2)

      const afterSend2 = await pollUntil(
        read,
        b => b.recipientProg >= afterSend1.recipientProg + amount,
        'recipient BRC2.0 to rise by the amount'
      )
      console.warn('after sendAsBrc20Prog', afterSend2)
      assert.equal(afterSend2.recipientProg, afterSend1.recipientProg + amount)
      assert.equal(afterSend2.senderBase, afterSend1.senderBase - one)
      assert.equal(afterSend2.senderProg, afterSend1.senderProg - fromProg)
    }
  )
})
