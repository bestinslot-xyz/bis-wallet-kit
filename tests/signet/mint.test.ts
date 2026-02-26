/* eslint-disable no-console */
import process from 'node:process'
import { beforeAll, describe, it } from 'vitest'
import { jsonInscription, mint, wallet } from '../../src/main.ts'

describe('tests for BRC20', () => {
  beforeAll(() => {
    if (!process.env.PRIVATE_KEY_WIF) {
      throw new Error('PRIVATE_KEY_WIF environment variable is not set')
    }
  })

  it('should deploy a token', async () => {
    const randomTickerName = Math.random().toString(36).substring(2, 6)
    const localWallet = await wallet.connectLocalWallet(process.env.PRIVATE_KEY_WIF!, 'signet', 'p2tr', 'unisat')
    console.log('Connected!')
    console.log('Address:', localWallet.address)

    console.log('Deploying ticker:', randomTickerName)
    const brc20DeployInscription = jsonInscription({
      p: 'brc-20',
      op: 'deploy',
      tick: randomTickerName,
      max: 1000000000,
      lim: 10,
      dec: 18,
    })
    const mintResult = await mint.inscribe(
      brc20DeployInscription,
      2,
      null,
      true,
    )
    console.log('Mint result:', mintResult)
  })
})
