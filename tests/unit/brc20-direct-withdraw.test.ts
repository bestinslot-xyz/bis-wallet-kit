import { Buffer } from 'node:buffer'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { selfFundedSendPostage, sendVsize } from '../../src/core/brc20-direct-withdraw.ts'
import { brc20, wallet } from '../../src/node.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const P2WPKH = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const P2TR = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const net = bitcoin.networks.testnet

const SCRIPT_TYPE = {
  p2wpkh: 'witness_v0_keyhash',
  p2tr: 'witness_v1_taproot',
} as const

let sentBodies: string[][]
let testedBodies: string[][]
let rejectThirdTx: boolean

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

/** Connects a local wallet of `type` holding one 200000-sat cardinal UTXO, with chain calls stubbed. */
async function connect(type: 'p2wpkh' | 'p2tr') {
  const address = type === 'p2wpkh' ? P2WPKH : P2TR
  const script = bitcoin.address.toOutputScript(address, net)
  const prev = new bitcoin.Transaction()
  prev.addInput(Buffer.alloc(32, type === 'p2wpkh' ? 7 : 8), 0)
  prev.addOutput(script, 200000)
  const txid = prev.getId()
  const utxo = {
    utxo: `${txid}:0`,
    txid,
    vout: 0,
    value: 200000,
    script_type: SCRIPT_TYPE[type],
    script: script.toString('hex'),
    address,
    amounts: null,
    block_height: 1,
    inscription_ids: null,
    rune_ids: null,
    satpoints: null,
    txfee: null,
    vsize: null,
  }
  sentBodies = []
  testedBodies = []
  rejectThirdTx = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('/cardinal_utxos/')) return jsonResponse({ data: [utxo] })
      if (u.includes('/gettxhex/')) return jsonResponse(u.endsWith(txid) ? prev.toHex() : '')
      if (u.includes('/testmempoolaccept')) {
        const txhexes: string[] = JSON.parse(opts.body).txhexes
        testedBodies.push(txhexes)
        return jsonResponse(
          txhexes.map((_, i) =>
            rejectThirdTx && i === 2
              ? { allowed: false, 'reject-reason': 'bad-send' }
              : { allowed: true }
          )
        )
      }
      if (u.includes('/sendrawtransactions')) {
        sentBodies.push(JSON.parse(opts.body).txhexes)
        return jsonResponse([])
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
  )
  await wallet.connectLocalWallet(WIF, 'testnet', type, 'unisat')
  return { address, script, prevValue: 200000 }
}

function witnessHex(tx: bitcoin.Transaction): string {
  return tx.ins.flatMap(i => i.witness.map(w => w.toString('hex'))).join('')
}

/** Whether the send's single input carries a valid key-path signature for the reveal output. */
function sendSignatureValid(send: bitcoin.Transaction, prevOut: bitcoin.TxOutput): boolean {
  const witness = send.ins[0]!.witness
  if (prevOut.script[0] === bitcoin.opcodes.OP_1) {
    const hash = send.hashForWitnessV1(
      0,
      [prevOut.script],
      [prevOut.value],
      bitcoin.Transaction.SIGHASH_DEFAULT
    )
    return ecc.verifySchnorr(hash, prevOut.script.subarray(2), witness[0]!.subarray(0, 64))
  }
  const { signature, hashType } = bitcoin.script.signature.decode(witness[0]!)
  const scriptCode = bitcoin.payments.p2pkh({ hash: prevOut.script.subarray(2) }).output!
  const hash = send.hashForWitnessV0(0, scriptCode, prevOut.value, hashType)
  return ecc.verify(hash, witness[1]!, signature)
}

function outpoint(input: bitcoin.Transaction['ins'][number]): string {
  return `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`
}

const CONTENT =
  '{"p":"brc20-module","op":"withdraw","tick":"ordi","amt":"1.5","module":"BRC20PROG"}'

describe('selfFundedSendPostage', () => {
  it('covers the dust output plus the 1-in 1-out send fee', () => {
    assert.equal(selfFundedSendPostage('p2tr', 10), 330 + Math.ceil(111 * 10))
    assert.equal(selfFundedSendPostage('p2wpkh', 10), 294 + Math.ceil(110 * 10))
    assert.equal(selfFundedSendPostage('p2tr', 1.5), 330 + Math.ceil(111 * 1.5))
  })

  it('prices a send whose target type differs from the inscription input', () => {
    // p2wpkh input (68 vB) to a p2tr output (43 vB): 10.5 + 68 + 43 = 121.5, rounded up.
    assert.equal(sendVsize('p2wpkh', 'p2tr'), 122)
    assert.equal(selfFundedSendPostage('p2wpkh', 10, 'p2tr'), 330 + 1220)
  })

  it('refuses an inscription input it cannot price', () => {
    assert.throws(() => selfFundedSendPostage('p2pkh', 10), /p2pkh/)
  })
})

describe('prepareBrc20ProgWithdraw', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const type of ['p2wpkh', 'p2tr'] as const) {
    it(`signs a ${type} commit, reveal and self-funded send without broadcasting`, async () => {
      const { address, script, prevValue } = await connect(type)
      const prompts: { step: number; total?: number }[] = []
      const feeRate = 10

      const res = await brc20.prepareBrc20ProgWithdraw({
        tick: 'ordi',
        amount: '1.5',
        targetAddress: address,
        feeRate,
        onSignRequest: r => prompts.push(r),
      })

      const commit = bitcoin.Transaction.fromHex(res.commitTxHex)
      const reveal = bitcoin.Transaction.fromHex(res.revealTxHex)
      const send = bitcoin.Transaction.fromHex(res.sendTxHex)
      assert.equal(commit.getId(), res.commitTxId)
      assert.equal(reveal.getId(), res.revealTxId)
      assert.equal(send.getId(), res.sendTxId)
      assert.equal(res.inscriptionId, `${res.revealTxId}i0`)

      const postage = selfFundedSendPostage(type, feeRate)
      const dust = type === 'p2wpkh' ? 294 : 330
      assert.equal(reveal.outs.length, 1)
      assert.equal(reveal.outs[0]!.value, postage)
      assert.ok(reveal.outs[0]!.script.equals(script))

      assert.equal(send.ins.length, 1)
      assert.equal(outpoint(send.ins[0]!), `${res.revealTxId}:0`)
      assert.equal(send.outs.length, 1)
      assert.ok(send.outs[0]!.script.equals(script))
      assert.equal(send.outs[0]!.value, dust)
      // The send is signed by the ordinals key, signals RBF, and fits the vsize its postage was priced at.
      assert.ok(sendSignatureValid(send, reveal.outs[0]!))
      const tampered = send.clone()
      tampered.outs[0]!.value += 1
      assert.notOk(sendSignatureValid(tampered, reveal.outs[0]!))
      assert.ok(send.ins[0]!.sequence < 0xfffffffe)
      assert.ok(send.virtualSize() <= sendVsize(type, type))

      assert.include(witnessHex(reveal), Buffer.from(CONTENT).toString('hex'))

      // Miner fees of all three: everything the commit spends, less its change and the dust kept.
      const change = commit.outs
        .filter(o => o.script.equals(script))
        .reduce((sum, o) => sum + o.value, 0)
      assert.equal(res.feeSats, prevValue - change - dust)

      assert.deepEqual(testedBodies.at(-1), [res.commitTxHex, res.revealTxHex, res.sendTxHex])
      assert.equal(sentBodies.length, 0)
      assert.deepEqual(prompts, [
        { step: 1, total: 2 },
        { step: 2, total: 2 },
      ])

      // The quote prices the same chain without signing.
      assert.equal(
        await brc20.getBrc20ProgWithdrawFee({
          tick: 'ordi',
          amount: '1.5',
          targetAddress: address,
          feeRate,
        }),
        res.feeSats
      )
      assert.equal(sentBodies.length, 0)
    })
  }

  it('pays the dust of a target whose type differs from the ordinals address', async () => {
    await connect('p2wpkh')
    const res = await brc20.prepareBrc20ProgWithdraw({
      tick: 'ordi',
      amount: '1.5',
      targetAddress: P2TR,
      feeRate: 3,
    })
    const reveal = bitcoin.Transaction.fromHex(res.revealTxHex)
    const send = bitcoin.Transaction.fromHex(res.sendTxHex)
    assert.equal(reveal.outs[0]!.value, selfFundedSendPostage('p2wpkh', 3, 'p2tr'))
    assert.ok(send.outs[0]!.script.equals(bitcoin.address.toOutputScript(P2TR, net)))
    assert.equal(send.outs[0]!.value, 330)
  })

  it('refuses the chain when the package rejects the send', async () => {
    await connect('p2tr')
    rejectThirdTx = true
    await expect(
      brc20.prepareBrc20ProgWithdraw({
        tick: 'ordi',
        amount: '1.5',
        targetAddress: P2TR,
        feeRate: 3,
      })
    ).rejects.toThrow('bad-send')
    assert.equal(sentBodies.length, 0)
  })
})
