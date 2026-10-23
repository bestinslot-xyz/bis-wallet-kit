import { afterEach, assert, describe, it, vi } from 'vitest'
import { BackendError } from '../../src/core/backend-error.ts'
import { fetchWithErrors } from '../../src/core/helpers.ts'

const URL = 'https://swap.example/v1/get_deposit_signature'

function respond(status: number, body: string, statusText = '') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, statusText }))
  )
}

async function failure(): Promise<BackendError> {
  try {
    await fetchWithErrors(URL, { method: 'GET' })
  } catch (e) {
    assert.instanceOf(e, BackendError)
    return e as BackendError
  }
  throw new Error('fetchWithErrors resolved')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchWithErrors', () => {
  it('resolves a 2xx JSON body', async () => {
    respond(200, JSON.stringify({ data: [1] }))
    assert.deepEqual(await fetchWithErrors(URL, { method: 'GET' }), { data: [1] })
  })

  it('carries the status, code, ref and text of a JSON error body', async () => {
    respond(
      409,
      JSON.stringify({
        error: 'Registered with a different swap key.',
        code: 'WALLET_KEY_MISMATCH',
        ref: '1a2b3c4d',
      })
    )
    const e = await failure()
    assert.equal(e.status, 409)
    assert.equal(e.code, 'WALLET_KEY_MISMATCH')
    assert.equal(e.ref, '1a2b3c4d')
    assert.equal(e.detail, 'Registered with a different swap key.')
    assert.equal(e.message, 'API Request Failed: Registered with a different swap key.')
    assert.equal(e.url, URL)
    assert.equal(e.name, 'BackendError')
  })

  it('keeps a JSON body without an `error` field as text', async () => {
    respond(500, JSON.stringify({ status: 'error', message: 'db down' }))
    const e = await failure()
    assert.equal(e.detail, '{"status":"error","message":"db down"}')
    assert.isUndefined(e.ref)
  })

  it('leaves code undefined for an error body without one', async () => {
    respond(400, JSON.stringify({ error: 'Invalid pubkey.' }))
    const e = await failure()
    assert.equal(e.status, 400)
    assert.isUndefined(e.code)
    assert.equal(e.detail, 'Invalid pubkey.')
  })

  it('keeps a plain-text error body as the detail', async () => {
    respond(413, 'Wallet has too many UTXOs')
    const e = await failure()
    assert.equal(e.status, 413)
    assert.equal(e.detail, 'Wallet has too many UTXOs')
  })

  it('falls back to the status line for an empty body', async () => {
    respond(502, '', 'Bad Gateway')
    assert.equal((await failure()).detail, 'HTTP Error: 502 Bad Gateway')
  })

  it('throws for an `error` field inside a 2xx body', async () => {
    respond(200, JSON.stringify({ error: 'Not enough balance', code: 'X' }))
    const e = await failure()
    assert.equal(e.status, 200)
    assert.equal(e.code, 'X')
    assert.equal(e.detail, 'Not enough balance')
  })

  it('reports a request that never completed with no status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    const e = await failure()
    assert.isUndefined(e.status)
    assert.equal(e.detail, 'Failed to fetch')
  })
})
