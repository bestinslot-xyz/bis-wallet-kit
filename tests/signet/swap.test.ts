import { assert, beforeAll, describe, it } from 'vitest'
import { swap, wallet } from '../../src/main.ts'

describe('tests for swap (signet)', () => {
  beforeAll(() => {
    wallet.setNetwork('signet')
  })

  it('should return a valid swap status', async () => {
    const status = await swap.getSwapStatus()
    assert.ok(typeof status.reorg_handler_running === 'boolean')
    assert.ok(typeof status.emergency_stop === 'boolean')
  })
})
