import { assert, beforeAll, describe, it } from 'vitest'
import { saveInfo } from '../../src/lib/uniswap_ops.ts'
import { getEvmAddressFromBitcoinAddress, getEvmAddressFromPkScript, swap, wallet } from '../../src/main.ts'

// Golden vectors computed independently (raw bitcoinjs / web3 / ethers), so these
// assert real behaviour rather than mirroring the implementation. See the docs
// for how they were derived.

describe('evm address derivation', () => {
  const BTC_ADDR = 'bc1plnw9577kddxn4ry37xsul99d04tp7w3sf0cclt6k0zc7u3l8swmsfylw0g'
  const PKSCRIPT = '5120fcdc5a7bd66b4d3a8c91f1a1cf94ad7d561f3a304bf18faf5678b1ee47e783b7'
  const EXPECTED = '0xabef96cf084890c7d0e611fbcd90284644e69324'

  beforeAll(() => wallet.setNetwork('mainnet'))

  it('derives the evm address from a bitcoin address', () => {
    assert.equal(getEvmAddressFromBitcoinAddress(BTC_ADDR).toLowerCase(), EXPECTED)
  })

  it('derives the evm address from a pkscript', () => {
    assert.equal(getEvmAddressFromPkScript(PKSCRIPT).toLowerCase(), EXPECTED)
  })

  it('agrees between the two derivation paths', () => {
    assert.equal(
      getEvmAddressFromBitcoinAddress(BTC_ADDR).toLowerCase(),
      getEvmAddressFromPkScript(PKSCRIPT).toLowerCase(),
    )
  })
})

describe('uniswap pair address', () => {
  const TOKEN_A = '0x077fe0e97B1bAD5040D5053384fF8099AB816481'
  const TOKEN_B = '0x237DFc53abe56C2818213A77610Fb4498a0Aeba5'
  const FACTORY = '0x0000000000000000000000000000000000001234'
  const EXPECTED = '0x73cbac40b1d601e1a2d1aa704bed9244fc311e4c'

  beforeAll(() => saveInfo('0x0000000000000000000000000000000000000001', FACTORY))

  it('computes the deterministic pair address', () => {
    assert.equal(swap.getPairAddress(TOKEN_A, TOKEN_B).toLowerCase(), EXPECTED)
  })

  it('is order-independent in its inputs', () => {
    assert.equal(
      swap.getPairAddress(TOKEN_A, TOKEN_B).toLowerCase(),
      swap.getPairAddress(TOKEN_B, TOKEN_A).toLowerCase(),
    )
  })
})
