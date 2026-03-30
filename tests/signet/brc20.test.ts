/* eslint-disable no-console */
import process from 'node:process'
import { assert, beforeAll, describe, it } from 'vitest'
import { brc20, wallet } from '../../src/main.ts'

const KNOWN_TICKER = 'atat'

describe('tests for BRC2.0 programmable module (signet)', () => {
  let walletAddress: string

  beforeAll(async () => {
    if (!process.env.PRIVATE_KEY_WIF) {
      throw new Error('PRIVATE_KEY_WIF environment variable is not set')
    }
    const localWallet = await wallet.connectLocalWallet(
      process.env.PRIVATE_KEY_WIF!,
      'signet',
      'p2tr',
      'unisat',
    )
    walletAddress = localWallet.address
    console.log('Connected, address:', walletAddress)
  })

  it.skipIf(!KNOWN_TICKER)('should dry-run deposit to BRC2.0 prog', async () => {
    const result = await brc20.depositToBrc20Prog(
      KNOWN_TICKER,
      '1',
      2,
      null,
      true, // dryRun
    )
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.revealTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(typeof result.signedRevealTxHex === 'string')
    assert.ok(typeof result.sendToOpReturnTxId === 'string')
    console.log('Deposit dry-run commitTxId:', result.commitTxId)
  })

  it.skipIf(!KNOWN_TICKER)('should dry-run withdraw from BRC2.0 prog', async () => {
    const result = await brc20.withdrawFromBrc20Prog(
      KNOWN_TICKER,
      '1',
      walletAddress,
      2,
      null,
      true, // dryRun
    )
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.revealTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(typeof result.signedRevealTxHex === 'string')
    assert.ok(typeof result.transferTxId === 'string')
    console.log('Withdraw dry-run commitTxId:', result.commitTxId)
  })
})
