import type { SignFunction } from '../../src/provider/api.ts'
import { assert, describe, it, vi } from 'vitest'
import { SignProgress } from '../../src/core/sign-progress.ts'

// SignProgress is what deposit and wrap count their wallet prompts with. Those
// flows need a live backend, so the counting itself is pinned here.

const fakeSign: SignFunction = async () => ({ txId: 'tx', signedTxHex: 'hex' })

describe('signProgress', () => {
  it('numbers message and PSBT prompts in one sequence, with the total', async () => {
    const seen: unknown[] = []
    const progress = new SignProgress({ onSignRequest: r => seen.push(r) }, 3)
    const signFn = progress.wrap(fakeSign)

    progress.next()
    await signFn('psbt', 'pay', 'ord', [0])
    await signFn('psbt', 'pay', 'ord', [0])

    assert.deepEqual(seen, [
      { step: 1, total: 3 },
      { step: 2, total: 3 },
      { step: 3, total: 3 },
    ])
  })

  it('leaves total unset when the flow cannot know it', () => {
    const seen: unknown[] = []
    const progress = new SignProgress({ onSignRequest: r => seen.push(r) })

    progress.next()

    assert.deepEqual(seen, [{ step: 1, total: undefined }])
  })

  it('reports before the wrapped sign call runs', async () => {
    const order: string[] = []
    const progress = new SignProgress({ onSignRequest: () => order.push('report') })
    const signFn = progress.wrap(async (...args) => {
      order.push('sign')
      return fakeSign(...args)
    })

    await signFn('psbt', 'pay', 'ord', [0])

    assert.deepEqual(order, ['report', 'sign'])
  })

  it('keeps signing when the callback throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const progress = new SignProgress({
      onSignRequest: () => {
        throw new Error('ui bug')
      },
    })

    const res = await progress.wrap(fakeSign)('psbt', 'pay', 'ord', [0])

    assert.equal(res.txId, 'tx')
    assert.equal(error.mock.calls.length, 1)
    error.mockRestore()
  })

  it('works with no options at all', async () => {
    const res = await new SignProgress().wrap(fakeSign)('psbt', 'pay', 'ord', [0])
    assert.equal(res.txId, 'tx')
  })
})
