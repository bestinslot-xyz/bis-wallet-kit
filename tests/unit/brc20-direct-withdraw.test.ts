import type { BISProvider } from '../../src/provider/api.ts'
import { Buffer } from 'node:buffer'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { selfFundedSendPostage, sendVsize } from '../../src/core/brc20-direct-withdraw.ts'
import { clearExtraUtxos, saveExtraUtxos } from '../../src/core/helpers.ts'
import { registerProvider } from '../../src/core/providers.ts'
import { saveWalletInfo } from '../../src/core/store.ts'
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
  return { address, script, prevValue: 200000, cardinal: utxo.utxo }
}

const KEY = ECPairFactory(ecc).fromWIF(WIF, net)
const X_ONLY = Buffer.from(KEY.publicKey).subarray(1, 33)
const TWEAKED = KEY.tweak(bitcoin.crypto.taggedHash('TapTweak', X_ONLY))

/**
 * A split wallet of the test key, as Xverse connects: payment and ordinals at different addresses.
 * It signs every input it is asked to with the key its script needs.
 */
const SPLIT_PROVIDER: BISProvider = {
  getWallets: async () => [],
  signMessage: async () => '',
  sign: async (unsignedPsbtHex, _payment, _ord, _ordIdxes, _tweak, noSignIdxes) => {
    const psbt = bitcoin.Psbt.fromHex(unsignedPsbtHex, { network: net })
    for (let i = 0; i < psbt.inputCount; i++) {
      if (noSignIdxes?.includes(i)) continue
      const script = psbt.data.inputs[i]!.witnessUtxo!.script
      if (script[0] === bitcoin.opcodes.OP_1) {
        psbt.signInput(i, {
          publicKey: Buffer.from(TWEAKED.publicKey),
          sign: h => Buffer.from(TWEAKED.signSchnorr(h)),
          signSchnorr: h => Buffer.from(TWEAKED.signSchnorr(h)),
        })
      } else {
        psbt.signInput(i, {
          publicKey: Buffer.from(KEY.publicKey),
          sign: h => Buffer.from(KEY.sign(h)),
        })
      }
      psbt.finalizeInput(i)
    }
    const tx = psbt.extractTransaction()
    return { txId: tx.getId(), signedTxHex: tx.toHex() }
  },
} as BISProvider

/**
 * Connects the split wallet with ordinals at `ordinalsType` and payment at the other type. The
 * payment address holds one 200000-sat cardinal UTXO, with chain calls stubbed.
 */
async function connectSplit(ordinalsType: 'p2wpkh' | 'p2tr') {
  const paymentType = ordinalsType === 'p2wpkh' ? 'p2tr' : 'p2wpkh'
  const payment = await connect(paymentType)
  const address = ordinalsType === 'p2wpkh' ? P2WPKH : P2TR
  const pubkey = Buffer.from(KEY.publicKey).toString('hex')
  registerProvider('xverse', SPLIT_PROVIDER)
  saveWalletInfo({
    provider: 'xverse',
    wallets: [
      { address: payment.address, pubkey, purpose: 'payment' },
      { address, pubkey, purpose: 'ordinals' },
    ],
    signature: null,
  })
  return {
    address,
    script: bitcoin.address.toOutputScript(address, net),
    paymentScript: payment.script,
    prevValue: payment.prevValue,
  }
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
    // p2tr: 10.5 + 57.75 (a 67-byte witness, room for an explicit sighash byte) + 43 = 111.25.
    assert.equal(sendVsize('p2tr', 'p2tr'), 112)
    assert.equal(selfFundedSendPostage('p2tr', 10), 330 + 112 * 10)
    assert.equal(selfFundedSendPostage('p2wpkh', 10), 294 + Math.ceil(110 * 10))
    assert.equal(selfFundedSendPostage('p2tr', 1.5), 330 + Math.ceil(112 * 1.5))
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

describe('sendBrc20ProgWithdrawToSelf', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const DUST = { p2wpkh: 294, p2tr: 330 } as const

  /**
   * Stubs a revealed withdraw inscription at `script` whose relay send sits in the mempool. The
   * provider reports the inscription on the stuck send's output (`elsewhere`) or not at all
   * (`missing`), as providers that follow or drop mempool spends do.
   */
  function stubStuckReveal(
    address: string,
    script: Buffer,
    type: 'p2wpkh' | 'p2tr',
    report: 'elsewhere' | 'missing'
  ) {
    // The reveal: 700 sats at the ordinals address, funded by a stand-in parent.
    const reveal = new bitcoin.Transaction()
    reveal.addInput(Buffer.alloc(32, 9), 0)
    reveal.addOutput(script, 700)
    const revealTxid = reveal.getId()
    const inscriptionId = `${revealTxid}i0`
    const stuck = new bitcoin.Transaction()
    stuck.addInput(Buffer.from(revealTxid, 'hex').reverse(), 0)
    stuck.addOutput(script, DUST[type])
    const stuckTxid = stuck.getId()
    const baseFetch = globalThis.fetch as unknown as (u: string, o?: any) => Promise<any>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, opts?: any) => {
        const u = String(url)
        if (u.includes('/inscription_utxo/')) {
          if (report === 'missing')
            return {
              ok: false,
              status: 404,
              statusText: 'Not Found',
              json: async () => ({}),
              text: async () => '',
            }
          return jsonResponse({
            data: {
              txid: stuckTxid,
              vout: 0,
              value: DUST[type],
              script_type: SCRIPT_TYPE[type],
              script: script.toString('hex'),
              address,
              block_height: null,
              inscription_ids: [inscriptionId],
              satpoints: [`${stuckTxid}:0:0`],
              amounts: null,
              rune_ids: null,
              txfee: null,
              vsize: null,
            },
          })
        }
        if (u.includes('/gettxhex/') && u.endsWith(revealTxid)) return jsonResponse(reveal.toHex())
        if (u.includes('/gettxhex/') && u.endsWith(stuckTxid)) return jsonResponse(stuck.toHex())
        if (u.includes('/sendrawtransactions')) {
          const txhexes: string[] = JSON.parse(opts.body).txhexes
          sentBodies.push(txhexes)
          return jsonResponse(txhexes.map(h => bitcoin.Transaction.fromHex(h).getId()))
        }
        return baseFetch(u, opts)
      })
    )
    return { revealTxid, inscriptionId }
  }

  for (const type of ['p2wpkh', 'p2tr'] as const) {
    for (const report of ['elsewhere', 'missing'] as const) {
      it(`replaces a stuck ${type} relay send spending the reveal output (provider: ${report})`, async () => {
        const { address, script } = await connect(type)
        const { revealTxid, inscriptionId } = stubStuckReveal(address, script, type, report)
        const prompts: { step: number; total?: number }[] = []

        const res = await brc20.sendBrc20ProgWithdrawToSelf({
          inscriptionId,
          feeRate: 12,
          onSignRequest: r => prompts.push(r),
        })

        assert.equal(sentBodies.length, 1)
        assert.equal(sentBodies[0]!.length, 1)
        const send = bitcoin.Transaction.fromHex(sentBodies[0]![0]!)
        assert.equal(send.getId(), res.txId)
        // Input 0 is the reveal output itself, so the send conflicts with the stuck one.
        assert.equal(outpoint(send.ins[0]!), `${revealTxid}:0`)
        assert.ok(send.outs[0]!.script.equals(script))
        assert.equal(send.outs[0]!.value, DUST[type])
        // The fee comes from a cardinal UTXO, so there is an input beyond the inscription.
        assert.isAbove(send.ins.length, 1)
        for (const input of send.ins) assert.isBelow(input.sequence, 0xfffffffe)
        assert.equal(prompts.length, 1)
      })
    }
  }

  it('never takes the inscription output as a fee input on a single-address wallet', async () => {
    const { address, script, cardinal } = await connect('p2tr')
    const { revealTxid, inscriptionId } = stubStuckReveal(address, script, 'p2tr', 'elsewhere')
    // A provider that has not indexed the reveal yet lists its output as a plain UTXO.
    const baseFetch = globalThis.fetch as unknown as (u: string, o?: any) => Promise<any>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, opts?: any) => {
        if (String(url).includes('/cardinal_utxos/')) {
          const listed = await (await baseFetch(String(url), opts)).json()
          const [funding] = listed.data
          return jsonResponse({
            data: [
              { ...funding, utxo: `${revealTxid}:0`, txid: revealTxid, vout: 0, value: 700 },
              funding,
            ],
          })
        }
        return baseFetch(String(url), opts)
      })
    )

    await brc20.sendBrc20ProgWithdrawToSelf({ inscriptionId, feeRate: 12 })

    const send = bitcoin.Transaction.fromHex(sentBodies[0]![0]!)
    assert.deepEqual(send.ins.map(outpoint), [`${revealTxid}:0`, cardinal])
  })

  it('pays the fee from the payment address of a split wallet', async () => {
    const { address, script, paymentScript } = await connectSplit('p2tr')
    const { revealTxid, inscriptionId } = stubStuckReveal(address, script, 'p2tr', 'elsewhere')

    await brc20.sendBrc20ProgWithdrawToSelf({ inscriptionId, feeRate: 12 })

    const send = bitcoin.Transaction.fromHex(sentBodies[0]![0]!)
    assert.equal(outpoint(send.ins[0]!), `${revealTxid}:0`)
    assert.ok(send.outs[0]!.script.equals(script))
    assert.isAbove(send.ins.length, 1)
    assert.ok(send.outs.slice(1).every(o => o.script.equals(paymentScript)))
  })

  it('refuses an inscription id that is not the first inscription of a reveal', async () => {
    await connect('p2wpkh')
    await expect(
      brc20.sendBrc20ProgWithdrawToSelf({ inscriptionId: `${'ab'.repeat(32)}i1`, feeRate: 3 })
    ).rejects.toThrow(/inscription/)
    assert.equal(sentBodies.length, 0)
  })

  it('refuses an invalid fee rate before signing', async () => {
    await connect('p2wpkh')
    await expect(
      brc20.sendBrc20ProgWithdrawToSelf({ inscriptionId: `${'ab'.repeat(32)}i0`, feeRate: 0 })
    ).rejects.toThrow()
    assert.equal(sentBodies.length, 0)
  })
})

describe('prepareBrc20ProgWithdraw', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const type of ['p2wpkh', 'p2tr'] as const) {
    it(`signs a ${type} commit, reveal and self-funded send without broadcasting`, async () => {
      const { address, script, paymentScript, prevValue } = await connectSplit(type)
      assert.isTrue(brc20.canPrepareBrc20ProgWithdraw())
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
        .filter(o => o.script.equals(paymentScript))
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
    await connectSplit('p2wpkh')
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

  for (const type of ['p2wpkh', 'p2tr'] as const) {
    it(`signs a ${type} chain for a wallet whose payment and ordinals address are the same`, async () => {
      const { address, script, prevValue, cardinal } = await connect(type)
      assert.isTrue(brc20.canPrepareBrc20ProgWithdraw())
      const feeRate = 10

      const res = await brc20.prepareBrc20ProgWithdraw({
        tick: 'ordi',
        amount: '1.5',
        targetAddress: address,
        feeRate,
      })

      const commit = bitcoin.Transaction.fromHex(res.commitTxHex)
      const reveal = bitcoin.Transaction.fromHex(res.revealTxHex)
      const send = bitcoin.Transaction.fromHex(res.sendTxHex)
      // The commit's only inputs are the wallet's cardinal UTXOs.
      assert.deepEqual(commit.ins.map(outpoint), [cardinal])
      assert.ok(reveal.outs[0]!.script.equals(script))
      assert.equal(reveal.outs[0]!.value, selfFundedSendPostage(type, feeRate))
      assert.equal(send.ins.length, 1)
      assert.equal(outpoint(send.ins[0]!), `${res.revealTxId}:0`)
      assert.ok(send.outs[0]!.script.equals(script))
      assert.ok(sendSignatureValid(send, reveal.outs[0]!))
      assert.isBelow(res.feeSats, prevValue)
      assert.deepEqual(testedBodies.at(-1), [res.commitTxHex, res.revealTxHex, res.sendTxHex])
      assert.equal(sentBodies.length, 0)

      // The quote prices the same chain.
      assert.equal(
        await brc20.getBrc20ProgWithdrawFee({
          tick: 'ordi',
          amount: '1.5',
          targetAddress: address,
          feeRate,
        }),
        res.feeSats
      )
    })
  }

  for (const ordinals of ['p2pkh', 'p2sh'] as const) {
    it(`refuses a ${ordinals} ordinals address before signing`, async () => {
      await connect('p2wpkh')
      const publicKey = Buffer.from(KEY.publicKey)
      const address =
        ordinals === 'p2pkh'
          ? bitcoin.payments.p2pkh({ pubkey: publicKey, network: net }).address!
          : bitcoin.payments.p2sh({
              redeem: bitcoin.payments.p2wpkh({ pubkey: publicKey, network: net }),
              network: net,
            }).address!
      registerProvider('xverse', SPLIT_PROVIDER)
      saveWalletInfo({
        provider: 'xverse',
        wallets: [
          { address: P2WPKH, pubkey: publicKey.toString('hex'), purpose: 'payment' },
          { address, pubkey: publicKey.toString('hex'), purpose: 'ordinals' },
        ],
        signature: null,
      })
      assert.isFalse(brc20.canPrepareBrc20ProgWithdraw())
      const args = { tick: 'ordi', amount: '1.5', targetAddress: P2WPKH, feeRate: 3 }
      await expect(brc20.prepareBrc20ProgWithdraw(args)).rejects.toThrow(
        new RegExp(`Cannot sign a withdraw send from a ${ordinals}`)
      )
      await expect(brc20.getBrc20ProgWithdrawFee(args)).rejects.toThrow(/withdraw send/)
      assert.equal(testedBodies.length, 0)
    })
  }

  it('cannot prepare without a connected wallet', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveWalletInfo({ provider: 'xverse', wallets: [], signature: null })
    assert.isFalse(brc20.canPrepareBrc20ProgWithdraw())
    logged.mockRestore()
  })

  it('refuses the chain when the package rejects the send', async () => {
    await connectSplit('p2tr')
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

  it('refuses while unbroadcast extra transactions are saved', async () => {
    await connect('p2wpkh')
    const parent = new bitcoin.Transaction()
    parent.addInput(Buffer.alloc(32, 5), 0)
    parent.addOutput(bitcoin.address.toOutputScript(P2WPKH, net), 10000)
    saveExtraUtxos([parent.toHex()], null)
    try {
      const args = { tick: 'ordi', amount: '1.5', targetAddress: P2WPKH, feeRate: 3 }
      await expect(brc20.prepareBrc20ProgWithdraw(args)).rejects.toThrow(/unbroadcast/)
      await expect(brc20.getBrc20ProgWithdrawFee(args)).rejects.toThrow(/unbroadcast/)
    } finally {
      clearExtraUtxos()
    }
    assert.equal(testedBodies.length, 0)
  })

  for (const tick of ['or"di', 'or\\di', '']) {
    it(`refuses the tick ${JSON.stringify(tick)} before signing`, async () => {
      await connect('p2wpkh')
      const args = { tick, amount: '1.5', targetAddress: P2WPKH, feeRate: 3 }
      await expect(brc20.prepareBrc20ProgWithdraw(args)).rejects.toThrow(/tick/)
      await expect(brc20.getBrc20ProgWithdrawFee(args)).rejects.toThrow(/tick/)
      assert.equal(testedBodies.length, 0)
    })
  }

  for (const amount of ['1.', '.5', '1e3', '-1', '1.5"', ' 1', '', '0', '0.0', '000']) {
    it(`refuses the amount ${JSON.stringify(amount)} before signing`, async () => {
      await connect('p2wpkh')
      const args = { tick: 'ordi', amount, targetAddress: P2WPKH, feeRate: 3 }
      await expect(brc20.prepareBrc20ProgWithdraw(args)).rejects.toThrow(/amount/)
      await expect(brc20.getBrc20ProgWithdrawFee(args)).rejects.toThrow(/amount/)
      assert.equal(testedBodies.length, 0)
    })
  }
})
