import { describe, expect, it } from 'vitest'
import { sendBTC } from '../../src/core/providers.ts'

// Amount validation happens before any provider lookup, so these run offline.
describe('sendBTC amount validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive-integer amount (%s)',
    async (amount) => {
      await expect(sendBTC(amount, 'tb1qexample')).rejects.toThrow(/positive integer/)
    },
  )
})
