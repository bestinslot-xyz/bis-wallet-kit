import { describe, expect, it } from 'vitest'
import { sumReclaimAmounts } from '../../src/core/bis_swap.ts'

describe('sumReclaimAmounts', () => {
  it('returns 0n for null/undefined/empty', () => {
    expect(sumReclaimAmounts(null)).toBe(0n)
    expect(sumReclaimAmounts(undefined)).toBe(0n)
    expect(sumReclaimAmounts([])).toBe(0n)
  })
  it('sums the amounts', () => {
    expect(
      sumReclaimAmounts([
        { inscriptionId: 'a', amount: 10n },
        { inscriptionId: 'b', amount: 25n },
      ])
    ).toBe(35n)
  })
})
