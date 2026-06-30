// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNetwork } from '../../src/adapters/react/use-network'
import { setNetwork } from '../../src/core/store-network'

afterEach(() => {
  setNetwork('mainnet')
})

describe('react useNetwork', () => {
  it('reads the current network', () => {
    const { result } = renderHook(() => useNetwork())
    expect(result.current[0]).toBe('mainnet')
  })

  it('reflects external store changes', () => {
    const { result } = renderHook(() => useNetwork())
    act(() => setNetwork('signet'))
    expect(result.current[0]).toBe('signet')
  })

  it('writes back to the store via the setter', () => {
    const { result } = renderHook(() => useNetwork())
    act(() => result.current[1]('testnet'))
    expect(result.current[0]).toBe('testnet')
  })
})
