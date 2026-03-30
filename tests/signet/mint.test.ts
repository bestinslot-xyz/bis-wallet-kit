/* eslint-disable no-console */
import process from 'node:process'
import { assert, beforeAll, describe, it } from 'vitest'
import { jsonInscription, mint, textInscription, wallet } from '../../src/main.ts'

describe('tests for BRC20', () => {
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
    console.log('Connected!')
    console.log('Address:', localWallet.address)
  })

  it('should deploy a token', async () => {
    const randomTickerName = Math.random().toString(36).substring(2, 6)
    console.log('Deploying ticker:', randomTickerName)
    const brc20DeployInscription = jsonInscription({
      p: 'brc-20',
      op: 'deploy',
      tick: randomTickerName,
      max: 1000000000,
      lim: 10,
      dec: 18,
    })
    const mintResult = await mint.inscribe(brc20DeployInscription, 2, null, true)
    console.log('Mint result:', mintResult)
  })

  it('should return fee estimate for a text inscription', async () => {
    const inscription = textInscription('hello world')
    const fees = await mint.getInscribeFee(inscription, 2, null)
    assert.ok(typeof fees.totalFee === 'number')
    assert.ok(fees.totalFee > 0)
    assert.ok(typeof fees.commitFee === 'number')
    assert.ok(typeof fees.revealFee === 'number')
  })

  it('should dry-run a single JSON inscription', async () => {
    const inscription = jsonInscription({ p: 'test', op: 'dry-run' })
    const result = await mint.inscribe(inscription, 2, null, true)
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(typeof result.revealTxId === 'string')
    assert.ok(typeof result.signedRevealTxHex === 'string')
    assert.ok(typeof result.inscriptionId === 'string')
  })

  it('should dry-run multiple inscriptions', async () => {
    const inscriptions = [textInscription('first'), textInscription('second')]
    const result = await mint.inscribeMultiple(inscriptions, 2, null, true)
    assert.ok(typeof result.commitTxId === 'string')
    assert.ok(typeof result.signedCommitTxHex === 'string')
    assert.ok(result.inscriptionIds.length === 2)
    assert.ok(result.inscriptionIds.every(id => typeof id === 'string'))
  })
})
