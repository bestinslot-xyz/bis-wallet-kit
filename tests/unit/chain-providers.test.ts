import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import * as browser from '../../src/browser.ts'
import { broadcastTxes, ethCallOnPublicRpc } from '../../src/core/helpers.ts'
import {
  BisBrc20RpcProvider,
  BisChainProvider,
  mint,
  opReturnWalletInfo,
  textInscription,
  wallet,
} from '../../src/node.ts'
import { InMemoryBrc20RpcProvider, InMemoryChainProvider } from './in-memory-providers.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const P2TR = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const NET = bitcoin.networks.testnet
const OP_RETURN = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from('BRC20PROG')])

let chain: InMemoryChainProvider
let fetchMock: ReturnType<typeof vi.fn>

function outpoints(txHex: string): string[] {
  return bitcoin.Transaction.fromHex(txHex).ins.map(
    i => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`
  )
}

describe('in-memory providers', () => {
  beforeEach(async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected HTTP request: ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    chain = new InMemoryChainProvider(NET)
    wallet.setProviders({ testnet: { chain } })
  })

  afterEach(() => {
    wallet.setProviders({})
    vi.unstubAllGlobals()
  })

  it('runs an inscription dry run with no HTTP request', async () => {
    const funding = chain.fund(P2TR, 50_000)

    const result = await mint.inscribe(textInscription('gm'), 2, null, true)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chain.broadcasts).toEqual([])
    expect(chain.mempoolTests).toEqual([[result.signedCommitTxHex, result.signedRevealTxHex]])
    expect(outpoints(result.signedCommitTxHex)).toEqual([`${funding.txid}:${funding.vout}`])
    expect(outpoints(result.signedRevealTxHex)).toEqual([`${result.commitTxId}:0`])
    expect(result.inscriptionId).toBe(`${result.revealTxId}i0`)
  })

  it('runs a send-to-OP_RETURN dry run with no HTTP request', async () => {
    const inscription = chain.inscribed(P2TR, 546)
    chain.fund(P2TR, 20_000)

    const result = await wallet.sendInscription(
      inscription.inscription_ids[0]!,
      opReturnWalletInfo(OP_RETURN),
      2,
      null,
      true
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chain.broadcasts).toEqual([])
    expect(chain.mempoolTests).toEqual([[result.signedTxHex]])
    const tx = bitcoin.Transaction.fromHex(result.signedTxHex)
    expect(tx.outs[result.vout]!.script.equals(OP_RETURN)).toBe(true)
    expect(outpoints(result.signedTxHex)).toContain(`${inscription.txid}:0`)
  })

  it('reads balances from the chain provider', async () => {
    chain.fund(P2TR, 1_000)
    chain.fund(P2TR, 2_500)
    chain.inscribed(P2TR, 546)

    expect(await wallet.getCardinalBalance(P2TR)).toBe(3_500)
    expect(await wallet.getAllBalanceDetails(P2TR)).toEqual({
      confirmed_balance: 4_046,
      mempool_balance: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('broadcasts through the chain provider and returns its txids', async () => {
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, 1), 0)
    tx.addOutput(OP_RETURN, 0)

    expect(await broadcastTxes([tx.toHex()])).toEqual([tx.getId()])
    expect(chain.broadcasts).toEqual([[tx.toHex()]])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends BRC2.0 eth_call reads through the RPC provider', async () => {
    const rpc = new InMemoryBrc20RpcProvider(() => `0x${'00'.repeat(31)}2a`)
    wallet.setProviders({ testnet: { chain, brc20Rpc: rpc } })
    const abi = [
      {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ]
    const to = '0x1eb63d0d0e5a86146b4e1cebc79b1d6e35093288'
    const account = `0x${'11'.repeat(20)}`

    const result = await ethCallOnPublicRpc(to, abi, 'balanceOf', [account])

    expect(BigInt(result)).toBe(42n)
    expect(rpc.requests).toEqual([
      {
        method: 'eth_call',
        params: [{ to, data: `0x70a08231${'0'.repeat(24)}${'11'.repeat(20)}` }, 'latest'],
      },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('verifies a signed message locally', async () => {
    const signature = await wallet.signMessage('gm', 'payment')
    assert.ok(signature.length > 0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('setProviders', () => {
  afterEach(() => {
    wallet.setProviders({})
  })

  it('is exported with the default providers from both build flavours', () => {
    for (const kit of [browser, { BisChainProvider, BisBrc20RpcProvider, wallet }]) {
      assert.equal(typeof kit.wallet.setProviders, 'function')
      assert.equal(typeof kit.wallet.getProviders, 'function')
      assert.equal(typeof kit.BisChainProvider, 'function')
      assert.equal(typeof kit.BisBrc20RpcProvider, 'function')
    }
  })

  it('uses the Best in Slot providers by default', () => {
    assert.ok(wallet.getProviders('signet').chain instanceof BisChainProvider)
    assert.ok(wallet.getProviders('signet').brc20Rpc instanceof BisBrc20RpcProvider)
  })

  it('overrides only the networks and keys passed, and {} restores the defaults', () => {
    const chain = new InMemoryChainProvider(NET)
    wallet.setProviders({ testnet: { chain } })
    assert.equal(wallet.getProviders('testnet').chain, chain)
    assert.ok(wallet.getProviders('testnet').brc20Rpc instanceof BisBrc20RpcProvider)
    assert.ok(wallet.getProviders('mainnet').chain instanceof BisChainProvider)

    wallet.setProviders({})
    assert.ok(wallet.getProviders('testnet').chain instanceof BisChainProvider)
  })

  it('rejects unknown networks and keys, and providers missing a method', () => {
    assert.throws(() => wallet.setProviders({ regtest: {} } as never), /unknown network 'regtest'/)
    assert.throws(
      () => wallet.setProviders({ signet: { indexer: {} } } as never),
      /unknown provider 'indexer'/
    )
    const partial = {
      cardinalUtxos: async () => [],
      ordinalUtxos: async () => [],
      balance: async () => ({ confirmed: 0, mempool: 0 }),
      txHex: async () => '',
      testMempoolAccept: async () => [],
    }
    assert.throws(
      () => wallet.setProviders({ signet: { chain: partial } } as never),
      /signet\.chain has no broadcast\(\) method/
    )
    assert.throws(
      () => wallet.setProviders({ signet: { brc20Rpc: {} } } as never),
      /signet\.brc20Rpc has no request\(\) method/
    )
  })
})

describe('default providers with constructor endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('send requests to the endpoints passed to the constructor', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url))
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ data: [], result: '0x' }),
        }
      })
    )
    await new BisChainProvider({
      indexer: 'https://idx.example/',
      tx: 'https://tx.example',
    }).cardinalUtxos('tb1qaddr')
    await new BisChainProvider({ tx: 'https://tx.example' }).testMempoolAccept(['00'])
    await new BisBrc20RpcProvider({ rpc: 'https://rpc.example' }).request('eth_blockNumber', [])

    assert.deepEqual(urls, [
      'https://idx.example/cardinal_utxos/tb1qaddr',
      'https://tx.example/testmempoolaccept',
      'https://rpc.example',
    ])
  })

  it('reject non-http(s) constructor endpoints', () => {
    assert.throws(() => new BisChainProvider({ indexer: 'ftp://x.example' }), /http\(s\) URL/)
    assert.throws(() => new BisBrc20RpcProvider({ rpc: 'not a url' }), /not a valid URL/)
  })
})
