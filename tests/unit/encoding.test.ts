import { Buffer } from 'node:buffer'
import { assert, describe, it } from 'vitest'
import { base64ToHex, createUnsecuredToken, hexToBase64 } from '../../src/core/helpers.ts'
import { brc20MintInscription, delegateInscription, jsonInscription, textInscription } from '../../src/main.ts'

describe('hex <-> base64', () => {
  it('round-trips hex through base64', () => {
    const hex = 'deadbeef0102'
    assert.equal(base64ToHex(hexToBase64(hex)), hex)
  })

  it('base64ToHex returns lowercase hex', () => {
    // base64 of bytes [0xAB, 0xCD]
    assert.equal(base64ToHex('q80='), 'abcd')
  })

  it('hexToBase64 rejects non-hex characters', () => {
    assert.throws(() => hexToBase64('zz'), /Invalid hex string/)
    assert.throws(() => hexToBase64('!!'), /Invalid hex string/)
  })

  it('hexToBase64 rejects odd-length input instead of dropping a nibble', () => {
    assert.throws(() => hexToBase64('abc'), /Invalid hex string/)
  })

  it('hexToBase64 rejects an empty string', () => {
    assert.throws(() => hexToBase64(''), /Invalid hex string/)
  })
})

describe('createUnsecuredToken', () => {
  it('produces a 3-part unsecured JWT ending in a dot', () => {
    const token = createUnsecuredToken({ hello: 'world' })
    const parts = token.split('.')
    assert.equal(parts.length, 3)
    assert.equal(parts[2], '') // unsecured: empty signature
    // header decodes to the "none" alg (base64url, decoded via Buffer to avoid atob padding/runtime issues)
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())
    assert.equal(header.alg, 'none')
    assert.equal(header.typ, 'JWT')
  })

  it('is url-safe (no +, / or = in the payload)', () => {
    const token = createUnsecuredToken({ a: 'a/b+c==' })
    assert.ok(!/[+/=]/.test(token.replace(/\.$/, '')))
  })
})

describe('inscription builders', () => {
  it('textInscription sets text/plain mime and the text as data', () => {
    const ins = textInscription('hello world')
    assert.equal(ins.mimeType?.str, 'text/plain')
    assert.equal(ins.data?.str, 'hello world')
    assert.equal(ins.delegate, null)
  })

  it('jsonInscription serialises JSON with the json mime type', () => {
    const ins = jsonInscription({ p: 'brc-20', op: 'deploy' })
    assert.equal(ins.mimeType?.str, 'application/json')
    assert.equal(ins.data?.str, JSON.stringify({ p: 'brc-20', op: 'deploy' }))
  })

  it('delegateInscription carries the delegate id and no data', () => {
    const id = 'abc123i0'
    const ins = delegateInscription(id)
    assert.equal(ins.delegate?.str, id)
    assert.equal(ins.data, null)
    assert.equal(ins.mimeType, null)
  })

  it('brc20MintInscription builds the standard brc-20 mint JSON with a string amount', () => {
    const ins = brc20MintInscription('abcd', 1000n)
    assert.equal(ins.mimeType?.str, 'application/json')
    assert.deepEqual(JSON.parse(ins.data!.str), {
      p: 'brc-20',
      op: 'mint',
      tick: 'abcd',
      amt: '1000',
    })
  })
})
