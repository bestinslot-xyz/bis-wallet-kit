import type * as bitcoin from 'bitcoinjs-lib'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BisChainProvider } from '../../src/core/bis-providers.ts'
import { clearExtraUtxos, getCardinalUtxos, saveExtraUtxos } from '../../src/core/helpers.ts'
import { buildTransaction, buildTransactionMultiOutput } from '../../src/core/mint.ts'
import {
  bestRecoverable,
  dustForScriptType,
  inscribedSatRanges,
  inscriptionsByOutput,
  inscriptionsOf,
  lastInscribedEndIn,
  outputRanges,
  recoverableSats,
} from '../../src/core/used-inscriptions.ts'
import { wallet } from '../../src/node.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
// Another testnet taproot address, standing in for a commit or recipient output.
const OTHER = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c'
const TAPROOT = 'witness_v1_taproot' as const

const opReturnWallet = new WalletInfo(
  true,
  Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
  null,
  null,
  null
)

async function wallets() {
  const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
  return {
    payer: new WalletInfo(false, null, w.address, null, w.pubkey),
    other: new WalletInfo(false, null, OTHER, null, null),
  }
}

/** A cardinal output carrying used inscriptions at the given offsets. */
function inscribed(txByte: string, value: number, offsets: number[]) {
  const txid = txByte.repeat(32)
  return {
    utxo: `${txid}:0`,
    value,
    script_type: TAPROOT,
    inscription_ids: offsets.map((_, i) => `${'ee'.repeat(32)}i${i}`),
    satpoints: offsets.map(o => `${txid}:0:${o}`),
  }
}

function plain(txByte: string, value: number) {
  return { utxo: `${txByte.repeat(32)}:0`, value, script_type: TAPROOT }
}

/**
 * The spent outpoint of input `i` of a transaction wallet-kit built, whose input hashes are in
 * txid (display) order.
 */
function spent(tx: bitcoin.Transaction, i: number) {
  return `${Buffer.from(tx.ins[i]!.hash).toString('hex')}:${tx.ins[i]!.index}`
}

/** The transaction as a wallet signs and serializes it: input hashes in internal byte order. */
function asSerialized(tx: bitcoin.Transaction) {
  const copy = tx.clone()
  for (const input of copy.ins) input.hash = Buffer.from(input.hash).reverse()
  return copy
}

/** How many inscriptions each output of `tx` receives, from the inputs as listed in `pool`. */
function landing(tx: bitcoin.Transaction, pool: { utxo: string; value: number }[]) {
  const byOutpoint = new Map(pool.map(u => [u.utxo, u]))
  const inputs = tx.ins.map((_, i) => ({
    utxo: byOutpoint.get(spent(tx, i)) ?? { value: 0 },
    skip: false,
  }))
  return inscriptionsByOutput(
    inputs,
    tx.outs.map(o => Number(o.value))
  ).map(o => o.at.length + (o.whole ? 1 : 0))
}

function scriptOf(w: WalletInfo) {
  return Buffer.from(w.outputScript).toString('hex')
}

afterEach(() => {
  clearExtraUtxos()
  vi.unstubAllGlobals()
})

describe('sat-flow helpers', () => {
  it('reads inscription offsets from satpoints', () => {
    const u = inscribed('aa', 2000, [0, 546])
    expect(inscriptionsOf(u)).toEqual({
      at: [
        { id: u.inscription_ids[0], offset: 0 },
        { id: u.inscription_ids[1], offset: 546 },
      ],
      whole: false,
    })
  })

  it('treats an inscription without a usable satpoint as covering the whole output', () => {
    expect(inscriptionsOf({ value: 600, inscription_ids: ['x'], satpoints: [] }).whole).toBe(true)
    expect(
      inscriptionsOf({ value: 600, inscription_ids: ['x'], satpoints: ['t:0:700'] }).whole
    ).toBe(true)
  })

  it('places inscribed sats in the outputs they reach', () => {
    const inputs = [
      { utxo: { value: 1000 }, skip: false },
      { utxo: inscribed('aa', 1000, [0, 600]), skip: false },
    ]
    expect(inscribedSatRanges(inputs)).toEqual([
      [1000, 1001],
      [1600, 1601],
    ])
    const byOutput = inscriptionsByOutput(inputs, [1200, 300, 400])
    expect(byOutput.map(o => o.at.map(a => a.offset))).toEqual([[1000], [], [100]])
    expect(lastInscribedEndIn(outputRanges([1200, 300, 400])[1]!, inscribedSatRanges(inputs))).toBe(
      -1
    )
  })

  it('skips the inscriptions of forced inputs', () => {
    expect(
      inscribedSatRanges([
        { utxo: inscribed('aa', 546, [0]), skip: true },
        { utxo: plain('bb', 1), skip: false },
      ])
    ).toEqual([])
  })
})

describe('building with used inscriptions', () => {
  it('changes nothing for outputs without inscriptions', async () => {
    const { payer, other } = await wallets()
    const built = buildTransaction(
      [plain('aa', 50000)],
      [],
      payer,
      [],
      other,
      payer,
      2,
      1000,
      null,
      null
    )
    expect(built.output_index).toEqual([0, 1])
    expect(built.tx.outs).toHaveLength(2)
  })

  it('sets a consolidated output aside in front of a commit, so the commit starts clean', async () => {
    const { payer, other } = await wallets()
    const consolidated = inscribed('aa', 50000, [0, 546, 1092])
    const built = buildTransaction([consolidated], [], payer, [], other, payer, 2, 1000, null, null)

    const commitVout = built.output_index[0]!
    expect(commitVout).toBe(1)
    const outs = built.tx.outs
    expect(outs).toHaveLength(3)
    expect(Buffer.from(outs[0]!.script).toString('hex')).toBe(scriptOf(payer))
    expect(Number(outs[0]!.value)).toBe(1093)
    expect(Number(outs[commitVout]!.value)).toBe(1000)
    expect(Buffer.from(outs[commitVout]!.script).toString('hex')).toBe(scriptOf(other))
    // Every inscription lands in the set-aside output, none in the commit or the change.
    expect(landing(built.tx, [consolidated])).toEqual([3, 0, 0])
  })

  it('sizes the set-aside output to at least the dust limit', async () => {
    const { payer, other } = await wallets()
    const one = inscribed('aa', 20000, [0])
    const built = buildTransaction([one], [], payer, [], other, payer, 2, 1000, null, null)
    expect(Number(built.tx.outs[0]!.value)).toBe(330)
    expect(landing(built.tx, [one])).toEqual([1, 0, 0])
  })

  it('puts outputs without inscriptions first, so inscribed sats reach the change', async () => {
    const { payer, other } = await wallets()
    const pool = [plain('aa', 4500), inscribed('bb', 2000, [0])]
    const built = buildTransaction(pool, [], payer, [], other, payer, 2, 4400, null, null)
    expect(built.tx.ins).toHaveLength(2)
    expect(spent(built.tx, 0)).toBe(`${'aa'.repeat(32)}:0`)
    expect(built.output_index).toEqual([0, 1])
    expect(built.tx.outs).toHaveLength(2)
    expect(landing(built.tx, pool)).toEqual([0, 1])
  })

  it('leaves outputs with used inscriptions alone while the plain ones can pay', async () => {
    const { payer, other } = await wallets()
    // Selection alone would take the 50,000-sat output: it prefers outputs above 10,000 sats.
    const pool = [plain('aa', 9000), inscribed('bb', 50000, [0])]
    const built = buildTransaction(pool, [], payer, [], other, payer, 2, 1000, null, null)
    expect(built.tx.ins.map((_, i) => spent(built.tx, i))).toEqual([`${'aa'.repeat(32)}:0`])
    expect(built.output_index).toEqual([0, 1])
    expect(built.tx.outs).toHaveLength(2)
  })

  it('leaves them alone in a multi-output build too', async () => {
    const { payer, other } = await wallets()
    const pool = [plain('aa', 9000), inscribed('bb', 50000, [0])]
    const built = buildTransactionMultiOutput(pool, [], payer, [other, other], [480, 480], payer, 2)
    expect(built.tx.ins.map((_, i) => spent(built.tx, i))).toEqual([`${'aa'.repeat(32)}:0`])
    expect(built.output_index).toEqual([0, 1, 2])
  })

  it('reports a plain shortfall when even the used-inscription outputs cannot pay', async () => {
    const { payer, other } = await wallets()
    const pool = [plain('aa', 1000), inscribed('bb', 2000, [0])]
    expect(() =>
      buildTransaction(pool, [], payer, [], other, payer, 2, 100000, null, null)
    ).toThrow(/^Not enough funds$/)
  })

  it('needs one set-aside output for a batch of commits', async () => {
    const { payer, other } = await wallets()
    const consolidated = inscribed('aa', 20000, [0, 546, 1092, 1638])
    const built = buildTransactionMultiOutput(
      [consolidated],
      [],
      payer,
      [other, other, other],
      [480, 480, 480],
      payer,
      2
    )
    expect(built.output_index).toEqual([1, 2, 3, 4])
    expect(Number(built.tx.outs[0]!.value)).toBe(1639)
    expect(landing(built.tx, [consolidated])).toEqual([4, 0, 0, 0, 0])
  })

  it('keeps a reclaim self-send in place and sets aside right before the commit', async () => {
    const { payer, other } = await wallets()
    const reclaim = {
      utxo: `${'dd'.repeat(32)}:0`,
      value: 546,
      script_type: TAPROOT,
      wallet: payer,
    }
    const consolidated = inscribed('aa', 20000, [0, 546])
    const built = buildTransactionMultiOutput(
      [consolidated],
      [reclaim],
      payer,
      [payer, other],
      [546, 600],
      payer,
      2
    )
    expect(built.output_index).toEqual([0, 2, 3])
    expect(Number(built.tx.outs[0]!.value)).toBe(546)
    expect(Number(built.tx.outs[1]!.value)).toBe(547)
  })

  it('never puts a set-aside output where forced-input sats go, and falls back to clean outputs', async () => {
    const { payer, other } = await wallets()
    const inscription = {
      utxo: `${'dd'.repeat(32)}:0`,
      value: 546,
      script_type: TAPROOT,
      wallet: payer,
    }
    // The handler output takes the inscription input's leftover sats, so used-inscription sats
    // can only reach it; the build spends the clean output alone.
    const pool = [plain('aa', 8000), inscribed('bb', 9000, [0])]
    const built = buildTransactionMultiOutput(
      pool,
      [inscription],
      payer,
      [opReturnWallet, other],
      [1, 7000],
      payer,
      1
    )
    expect(built.output_index).toEqual([0, 1, 2])
    const outpoints = built.tx.ins.map((_, i) => spent(built.tx, i))
    expect(outpoints).not.toContain(`${'bb'.repeat(32)}:0`)
    expect(outpoints).toContain(`${'aa'.repeat(32)}:0`)
  })

  it('explains a shortfall it cannot cover without sending inscriptions on', async () => {
    const { payer, other } = await wallets()
    const inscription = {
      utxo: `${'dd'.repeat(32)}:0`,
      value: 546,
      script_type: TAPROOT,
      wallet: payer,
    }
    expect(() =>
      buildTransactionMultiOutput(
        [inscribed('bb', 9000, [0])],
        [inscription],
        payer,
        [opReturnWallet, other],
        [1, 5000],
        payer,
        1
      )
    ).toThrow(/used BRC-20 inscriptions/)
  })

  it('keeps the inscriptions of a pending transaction on its outputs', async () => {
    const { payer, other } = await wallets()
    const consolidated = inscribed('aa', 50000, [0, 546])
    const built = buildTransaction([consolidated], [], payer, [], other, payer, 2, 1000, null, null)
    const broadcast = asSerialized(built.tx)
    saveExtraUtxos([broadcast.toHex()], null)

    const utxos = await getCardinalUtxos(payer.addr!, [])
    const txid = broadcast.getId()
    const sink = utxos.find(u => u.utxo === `${txid}:0`)!
    const change = utxos.find(u => u.utxo === `${txid}:2`)!
    expect(sink.inscription_ids).toEqual(consolidated.inscription_ids)
    expect(sink.satpoints).toEqual([`${txid}:0:0`, `${txid}:0:546`])
    expect(change.inscription_ids).toBeUndefined()

    // The next commit spends the clean change first and needs no set-aside output.
    const next = buildTransaction(utxos, [], payer, [], other, payer, 2, 1000, null, null)
    expect(next.output_index).toEqual([0, 1])
    expect(spent(next.tx, 0)).toBe(`${txid}:2`)
  })
})

describe('bisChainProvider includeUsedBrc20', () => {
  it('asks the cardinal_utxos route for used BRC-20 inscriptions only when set', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url))
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ data: [] }),
          text: async () => '{"data":[]}',
        }
      })
    )
    await new BisChainProvider({ indexer: 'https://idx.example' }).cardinalUtxos('tb1qaddr')
    await new BisChainProvider({
      indexer: 'https://idx.example',
      includeUsedBrc20: true,
    }).cardinalUtxos('tb1qaddr')
    expect(urls).toEqual([
      'https://idx.example/cardinal_utxos/tb1qaddr',
      'https://idx.example/cardinal_utxos/tb1qaddr?include_used_brc20=1',
    ])
  })
})

describe('recoverable BTC', () => {
  it('is what follows the last inscribed sat, beyond a dust-sized set-aside output', () => {
    expect(recoverableSats(inscribed('aa', 50000, [0, 330, 660]), 330)).toBe(50000 - 661)
    expect(recoverableSats(inscribed('aa', 50000, [0]), 330)).toBe(50000 - 330)
    // Postage-only outputs, as most used inscriptions sit on, give nothing.
    expect(recoverableSats(inscribed('aa', 330, [0]), 330)).toBe(0)
    expect(recoverableSats(inscribed('aa', 546, [0]), 546)).toBe(0)
    // Inscriptions at the end leave nothing after them.
    expect(recoverableSats(inscribed('aa', 50000, [49999]), 330)).toBe(0)
    expect(recoverableSats({ value: 50000, inscription_ids: ['x'], satpoints: [] }, 330)).toBe(0)
    expect(recoverableSats(plain('aa', 50000), 330)).toBe(0)
  })

  it('uses the dust limit of the output type', () => {
    expect(dustForScriptType('witness_v1_taproot')).toBe(330)
    expect(dustForScriptType('witness_v0_keyhash')).toBe(294)
    expect(dustForScriptType('scripthash')).toBe(540)
    expect(dustForScriptType('pubkeyhash')).toBe(546)
  })

  it('picks the inscribed output giving the most', () => {
    const small = inscribed('aa', 5000, [0])
    const big = inscribed('bb', 30000, [0, 330])
    const postage = inscribed('cc', 330, [0])
    expect(bestRecoverable([small, big, postage, plain('dd', 90000)])).toBe(big)
    expect(bestRecoverable([postage, plain('dd', 90000)])).toBeNull()
  })

  it('spends only the inscribed output giving the most', async () => {
    const { payer, other } = await wallets()
    const big = inscribed('aa', 30000, [0, 330])
    const pool = [inscribed('bb', 5000, [0]), big, inscribed('cc', 330, [0])]
    const built = buildTransaction(pool, [], payer, [], other, payer, 2, 20000, null, null)
    expect(built.tx.ins.map((_, i) => spent(built.tx, i))).toEqual([`${'aa'.repeat(32)}:0`])
    expect(landing(built.tx, pool)).toEqual([2, 0, 0])
  })

  it('reports a plain shortfall when the inscribed outputs give nothing', async () => {
    const { payer, other } = await wallets()
    const pool = [plain('aa', 1000), ...['bb', 'cc', 'dd'].map(b => inscribed(b, 330, [0]))]
    expect(() => buildTransaction(pool, [], payer, [], other, payer, 2, 1100, null, null)).toThrow(
      /^Not enough funds$/
    )
  })

  it('splits an inscribed output in a commit asked for change, so the change is clean', async () => {
    const { payer, other } = await wallets()
    const consolidated = inscribed('aa', 50000, [0, 330])
    const pool = [plain('bb', 9000), consolidated]
    const built = buildTransaction(pool, [], payer, [], other, payer, 2, 1000, null, null, 30000)
    const outs = built.tx.outs.map(o => Number(o.value))
    expect(built.output_index).toEqual([1, 2])
    expect(outs[0]).toBe(331)
    expect(outs[1]).toBe(1000)
    expect(outs[2]).toBeGreaterThanOrEqual(30000)
    expect(landing(built.tx, pool)).toEqual([2, 0, 0])
  })

  it('asks for no extra change without inscribed outputs', async () => {
    const { payer, other } = await wallets()
    const built = buildTransaction(
      [plain('aa', 9000)],
      [],
      payer,
      [],
      other,
      payer,
      2,
      1000,
      null,
      null,
      1_000_000
    )
    expect(built.tx.ins).toHaveLength(1)
    expect(built.output_index).toEqual([0, 1])
  })

  it('falls back to plain change when no inscribed output can give it', async () => {
    const { payer, other } = await wallets()
    const pool = [plain('aa', 9000), inscribed('bb', 330, [0])]
    const built = buildTransaction(pool, [], payer, [], other, payer, 2, 1000, null, null, 30000)
    expect(built.tx.ins.map((_, i) => spent(built.tx, i))).toEqual([`${'aa'.repeat(32)}:0`])
  })

  it('wallet.getCardinalBalances reports plain and recoverable BTC', async () => {
    const { payer } = await wallets()
    const utxos = [
      { txid: 'aa'.repeat(32), vout: 0, value: 9000 },
      {
        txid: 'bb'.repeat(32),
        vout: 0,
        value: 330,
        inscription_ids: ['i0'],
        satpoints: [`${'bb'.repeat(32)}:0:0`],
      },
      {
        txid: 'cc'.repeat(32),
        vout: 0,
        value: 50000,
        inscription_ids: ['i1', 'i2'],
        satpoints: [`${'cc'.repeat(32)}:0:0`, `${'cc'.repeat(32)}:0:330`],
      },
    ]
    const unused = async () => {
      throw new Error('unused')
    }
    wallet.setProviders({
      testnet: {
        chain: {
          cardinalUtxos: async () => utxos,
          ordinalUtxos: async () => [],
          balance: unused,
          txHex: unused,
          testMempoolAccept: unused,
          broadcast: unused,
        },
      },
    })
    try {
      const balances = await wallet.getCardinalBalances(payer.addr!)
      expect(balances.plain).toBe(9000)
      expect(balances.recoverable).toBe(50000 - 331)
      expect(balances.recoverableUtxo?.utxo).toBe(`${'cc'.repeat(32)}:0`)
    } finally {
      wallet.setProviders({})
    }
  })
})
