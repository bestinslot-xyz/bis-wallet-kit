import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  computeBrc20PredeployHash,
  deployBrc20Inscription,
  generateBrc20Salt,
  mintBrc20Inscription,
  predeployInscriptions,
  transferBrc20Inscription,
} from '../../src/core/brc20-inscriptions'
import { setNetwork } from '../../src/core/store-network'

// Known-answer vector from the 6-byte namespace spec:
// https://github.com/bestinslot-xyz/brc20-proposals/blob/main/001-6-byte-namespace/index.md
const VECTOR = {
  tick: 'ticker',
  salt: '73616c74',
  pkscript: '5120fcdc5a7bd66b4d3a8c91f1a1cf94ad7d561f3a304bf18faf5678b1ee47e783b7',
  hash: 'e87852f99ef17cae507d1eda1ddd29c2271812e05d9af33abf1e6301eba83618',
}

// The mainnet address whose output script is VECTOR.pkscript. predeployInscriptions
// derives the pkscript from this address on the current network.
const VECTOR_ADDRESS = bitcoinjs.address.fromOutputScript(
  Buffer.from(VECTOR.pkscript, 'hex'),
  bitcoinjs.networks.bitcoin,
)

// predeployInscriptions reads the current network to convert the address, so pin
// it to mainnet to match VECTOR_ADDRESS.
beforeAll(() => setNetwork('mainnet'))

function content(insc: { data: { str: string } | null }): any {
  return JSON.parse(insc.data!.str)
}

describe('brc20 inscription builders', () => {
  it('mint builds the mint-op payload with text/plain mime', () => {
    const insc = mintBrc20Inscription({ tick: 'ordi', amt: '1000' })
    expect(insc.mimeType!.str).toBe('text/plain')
    expect(content(insc)).toEqual({ p: 'brc-20', op: 'mint', tick: 'ordi', amt: '1000' })
  })

  it('transfer builds the transfer-op payload', () => {
    const insc = transferBrc20Inscription({ tick: 'ordi', amt: '5' })
    expect(content(insc)).toEqual({ p: 'brc-20', op: 'transfer', tick: 'ordi', amt: '5' })
  })

  it('4-byte deploy is free to mint (no self_mint)', () => {
    const insc = deployBrc20Inscription({ tick: 'ordi', max: '21000000', lim: '1000' })
    expect(content(insc)).toEqual({
      p: 'brc-20',
      op: 'deploy',
      tick: 'ordi',
      max: '21000000',
      lim: '1000',
    })
  })

  it('5-byte deploy forces self_mint (self-issuance)', () => {
    const insc = deployBrc20Inscription({ tick: 'ordit', max: '21000000' })
    expect(content(insc)).toEqual({
      p: 'brc-20',
      op: 'deploy',
      tick: 'ordit',
      max: '21000000',
      self_mint: 'true',
    })
  })

  it('5-byte deploy rejects selfMint:false', () => {
    expect(() => deployBrc20Inscription({ tick: 'ordit', max: '1', selfMint: false }))
      .toThrow(/self.?mint/i)
  })

  it('deploy includes optional dec', () => {
    const insc = deployBrc20Inscription({ tick: 'ordi', max: '1', dec: '6' })
    expect(content(insc).dec).toBe('6')
  })

  it('deploy rejects 6-byte tickers (must use predeployInscriptions)', () => {
    expect(() => deployBrc20Inscription({ tick: 'sixbyt', max: '1' }))
      .toThrow(/predeploy/i)
  })

  it('deploy rejects tickers outside 4-6 bytes', () => {
    expect(() => deployBrc20Inscription({ tick: 'abc', max: '1' })).toThrow()
    expect(() => deployBrc20Inscription({ tick: 'toolong', max: '1' })).toThrow()
  })

  it('computes the predeploy hash matching the spec vector', () => {
    expect(computeBrc20PredeployHash(VECTOR.tick, VECTOR.salt, VECTOR.pkscript)).toBe(VECTOR.hash)
  })

  it('generateBrc20Salt returns random hex of the requested byte length', () => {
    const a = generateBrc20Salt(16)
    const b = generateBrc20Salt(16)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
    expect(generateBrc20Salt(8)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('predeployInscriptions returns a matching predeploy + deploy pair', () => {
    const res = predeployInscriptions({
      tick: 'sixbyt',
      address: VECTOR_ADDRESS,
      max: '21000000',
      lim: '1000',
    })
    expect(res.salt).toMatch(/^[0-9a-f]+$/)
    expect(res.hash).toBe(computeBrc20PredeployHash('sixbyt', res.salt, VECTOR.pkscript))
    expect(content(res.predeploy)).toEqual({ p: 'brc-20', op: 'predeploy', hash: res.hash })
    expect(content(res.deploy)).toEqual({
      p: 'brc-20',
      op: 'deploy',
      tick: 'sixbyt',
      salt: res.salt,
      max: '21000000',
      lim: '1000',
      self_mint: 'true',
    })
  })

  it('predeployInscriptions reuses a caller-supplied salt', () => {
    const res = predeployInscriptions({
      tick: 'ticker',
      address: VECTOR_ADDRESS,
      salt: VECTOR.salt,
      max: '1',
    })
    expect(res.salt).toBe(VECTOR.salt)
    expect(res.hash).toBe(VECTOR.hash)
    expect(content(res.deploy).salt).toBe(VECTOR.salt)
  })

  it('predeployInscriptions rejects 6-byte tickers with illegal characters', () => {
    expect(() => predeployInscriptions({ tick: 'six!yt', address: VECTOR_ADDRESS, max: '1' }))
      .toThrow()
  })

  it('predeployInscriptions rejects non-6-byte tickers', () => {
    expect(() => predeployInscriptions({ tick: 'ordi', address: VECTOR_ADDRESS, max: '1' }))
      .toThrow()
  })

  it('rejects a non-hex salt', () => {
    expect(() => computeBrc20PredeployHash('ticker', 'xyz', VECTOR.pkscript)).toThrow()
  })

  it('computeBrc20PredeployHash rejects tickers that are not valid 6-byte tickers', () => {
    expect(() => computeBrc20PredeployHash('ordi', VECTOR.salt, VECTOR.pkscript)).toThrow()
    expect(() => computeBrc20PredeployHash('toolong', VECTOR.salt, VECTOR.pkscript)).toThrow()
    expect(() => computeBrc20PredeployHash('six!yt', VECTOR.salt, VECTOR.pkscript)).toThrow()
  })
})
