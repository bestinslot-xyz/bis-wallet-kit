import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBrc20Amount } from '../../src/core/brc20-send.ts'
import { compressSmartContractData, evmEncodeFunctionCall } from '../../src/core/brc20.ts'
import { brc20, getEvmAddressFromBitcoinAddress, wallet } from '../../src/node.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const PAYER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
// A p2wpkh local wallet uses one address for payments and ordinals.
const ORDINALS = PAYER
const RECIPIENT = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const CONTRACT = '0x1111111111111111111111111111111111111111'

const net = bitcoin.networks.testnet
const payerScript = bitcoin.address.toOutputScript(PAYER, net)
const ordinalsScript = bitcoin.address.toOutputScript(ORDINALS, net)
const recipientScript = bitcoin.address.toOutputScript(RECIPIENT, net)
const opReturnScript = bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN!,
  Buffer.from('BRC20PROG'),
])

function prevTxHex(value: number) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 9), 0)
  tx.addOutput(payerScript, value)
  return tx.toHex()
}

function fakeCardinalUtxo(txid: string, value: number) {
  return {
    utxo: `${txid}:0`,
    txid,
    vout: 0,
    value,
    script_type: 'witness_v0_keyhash',
    script: payerScript.toString('hex'),
    address: PAYER,
    amounts: null,
    block_height: 1,
    inscription_ids: null,
    rune_ids: null,
    satpoints: null,
    txfee: null,
    vsize: null,
  }
}

let utxos: ReturnType<typeof fakeCardinalUtxo>[]
let prevHexByTxid: Record<string, string>
const broadcastBodies: string[][] = []
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

function inputsOf(tx: bitcoin.Transaction): string[] {
  return tx.ins.map(i => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`)
}

function witnessHex(tx: bitcoin.Transaction): string {
  return tx.ins.flatMap(i => i.witness.map(w => w.toString('hex'))).join('')
}

/** Asserts the broadcast chain: no UTXO spent twice, and each step's commit spends the previous send's link output. */
function assertChained(txes: bitcoin.Transaction[], steps: number) {
  const spent = txes.flatMap(inputsOf)
  assert.equal(new Set(spent).size, spent.length, 'a UTXO is spent twice')
  for (let s = 1; s < steps; s++) {
    const prevSend = txes[s * 3 - 1]!
    const commit = txes[s * 3]!
    assert.equal(prevSend.outs[1]!.value, 1000)
    assert.ok(prevSend.outs[1]!.script.equals(payerScript))
    assert.include(inputsOf(commit), `${prevSend.getId()}:1`)
  }
}

describe('brc20 composite sends', () => {
  beforeEach(async () => {
    const txid = 'aa'.repeat(32)
    utxos = [fakeCardinalUtxo(txid, 200000)]
    prevHexByTxid = { [txid]: prevTxHex(200000) }
    broadcastBodies.length = 0

    fetchMock = vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('/cardinal_utxos/')) return jsonResponse({ data: utxos })
      if (u.includes('/gettxhex/'))
        return jsonResponse(prevHexByTxid[u.split('/gettxhex/')[1]!] ?? '')
      if (u.includes('/testmempoolaccept')) {
        const n = JSON.parse(opts.body).txhexes?.length ?? 1
        return jsonResponse(Array.from({ length: n }, () => ({ allowed: true })))
      }
      if (u.includes('/sendrawtransactions')) {
        const txhexes: string[] = JSON.parse(opts.body).txhexes
        broadcastBodies.push(txhexes)
        return jsonResponse(txhexes.map(hex => bitcoin.Transaction.fromHex(hex).getId()))
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await wallet.connectLocalWallet(WIF, 'testnet', 'p2wpkh', 'unisat')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sendAsBrc20 withdraws to the sender, then sends one transfer of the total to the recipient', async () => {
    const prompts: { step: number; total?: number }[] = []
    const res = await brc20.sendAsBrc20({
      tick: 'ordi',
      fromBrc20Amount: '5',
      fromProgAmount: '2.5',
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
      onSignRequest: r => prompts.push(r),
    })

    assert.equal(broadcastBodies.length, 1)
    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    assert.equal(txes.length, 6)
    assertChained(txes, 2)
    assert.deepEqual(
      res.txIds,
      txes.map(t => t.getId())
    )

    // The withdraw credits the sender's own base balance; only the transfer reaches the recipient.
    assert.ok(txes[2]!.outs[0]!.script.equals(ordinalsScript))
    assert.ok(txes[5]!.outs[0]!.script.equals(recipientScript))
    assert.equal(res.progWithdraw?.sendTxId, txes[2]!.getId())
    assert.equal(res.brc20Transfer?.sendTxId, txes[5]!.getId())

    assert.include(
      witnessHex(txes[1]!),
      Buffer.from(
        '{"p":"brc20-module","op":"withdraw","tick":"ordi","amt":"2.5","module":"BRC20PROG"}'
      ).toString('hex')
    )
    assert.include(
      witnessHex(txes[4]!),
      Buffer.from('{"p":"brc-20","op":"transfer","tick":"ordi","amt":"7.5"}').toString('hex')
    )

    assert.deepEqual(
      prompts.map(p => p.step),
      [1, 2, 3, 4]
    )
    assert.ok(prompts.every(p => p.total === 4))
  })

  it('sendAsBrc20 from the BRC2.0 balance alone still delivers a transfer inscription', async () => {
    const res = await brc20.sendAsBrc20({
      tick: 'ordi',
      fromBrc20Amount: '0',
      fromProgAmount: '0.000000000000000019',
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
    })
    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    assert.equal(txes.length, 6)
    assertChained(txes, 2)
    assert.ok(txes[2]!.outs[0]!.script.equals(ordinalsScript))
    assert.ok(txes[5]!.outs[0]!.script.equals(recipientScript))
    assert.include(
      witnessHex(txes[4]!),
      Buffer.from(
        '{"p":"brc-20","op":"transfer","tick":"ordi","amt":"0.000000000000000019"}'
      ).toString('hex')
    )
    assert.ok(res.progWithdraw)
    assert.ok(res.brc20Transfer)
  })

  it('sendAsBrc20 to the sender itself is the withdraw alone', async () => {
    const res = await brc20.sendAsBrc20({
      tick: 'ordi',
      fromBrc20Amount: '0',
      fromProgAmount: '1',
      recipient: ORDINALS,
      feeRate: 2,
      dryRun: false,
    })
    assert.equal(res.brc20Transfer, null)
    assert.ok(res.progWithdraw)
    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    assert.equal(txes.length, 3)
    assert.ok(txes[2]!.outs[0]!.script.equals(ordinalsScript))
    // The last send carries no link output.
    assert.equal(txes[2]!.outs.filter(o => o.value === 1000).length, 0)
  })

  it('sendAsBrc20 from the base balance alone is the transfer alone', async () => {
    const res = await brc20.sendAsBrc20({
      tick: 'ordi',
      fromBrc20Amount: '1',
      fromProgAmount: '0',
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
    })
    assert.equal(res.progWithdraw, null)
    assert.ok(res.brc20Transfer)
    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    assert.equal(txes.length, 3)
    assert.ok(txes[2]!.outs[0]!.script.equals(recipientScript))
  })

  it('sendAsBrc20Prog deposits the top-up, then calls transfer from the same chain', async () => {
    const amount = 3n * 10n ** 18n
    const res = await brc20.sendAsBrc20Prog({
      tick: 'ordi',
      contractAddress: CONTRACT,
      topUpFromBrc20: '1',
      amount,
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
    })

    const txes = broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
    assert.equal(txes.length, 6)
    assertChained(txes, 2)
    assert.ok(txes[2]!.outs[0]!.script.equals(opReturnScript))
    assert.ok(txes[5]!.outs[0]!.script.equals(opReturnScript))
    assert.equal(res.progDeposit?.sendTxId, txes[2]!.getId())
    assert.equal(res.progTransfer.sendTxId, txes[5]!.getId())

    assert.include(
      witnessHex(txes[1]!),
      Buffer.from('{"p":"brc-20","op":"transfer","tick":"ordi","amt":"1"}').toString('hex')
    )
    const calldata = evmEncodeFunctionCall(
      [
        {
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ],
      'transfer',
      [getEvmAddressFromBitcoinAddress(RECIPIENT), amount.toString()]
    )
    const call = `{"p":"brc20-prog","op":"c","c":"${CONTRACT}","b":"${await compressSmartContractData(calldata)}"}`
    assert.include(witnessHex(txes[4]!), Buffer.from(call).toString('hex'))
  })

  it('sendAsBrc20Prog without a top-up is the transfer call alone', async () => {
    const res = await brc20.sendAsBrc20Prog({
      tick: 'ordi',
      contractAddress: CONTRACT,
      topUpFromBrc20: '0',
      amount: 10n ** 18n,
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
    })
    assert.equal(res.progDeposit, null)
    assert.equal(broadcastBodies[0]!.length, 3)
  })

  it('dryRun quotes the chain without signing or broadcasting', async () => {
    const onSignRequest = vi.fn()
    const quote = await brc20.sendAsBrc20Prog({
      tick: 'ordi',
      contractAddress: CONTRACT,
      topUpFromBrc20: '1',
      amount: 2n * 10n ** 18n,
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: true,
      onSignRequest,
    })

    assert.equal(broadcastBodies.length, 0)
    expect(onSignRequest).not.toHaveBeenCalled()
    assert.deepEqual(
      quote.steps.map(s => s.step),
      ['progDeposit', 'progTransfer']
    )
    assert.equal(quote.walletPrompts, 4)
    assert.equal(quote.postageSats, 2)
    assert.ok(quote.minerFeeSats > 0)
    assert.equal(quote.totalSats, quote.minerFeeSats + quote.postageSats)
    assert.equal(quote.feeRate, 2)
  })

  it('dryRun quote for sendAsBrc20 counts the withdraw and recipient postage', async () => {
    const quote = await brc20.sendAsBrc20({
      tick: 'ordi',
      fromBrc20Amount: '1',
      fromProgAmount: '1',
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: true,
    })
    assert.equal(broadcastBodies.length, 0)
    assert.deepEqual(
      quote.steps.map(s => s.step),
      ['progWithdraw', 'brc20Transfer']
    )
    // p2wpkh dust (294) on the sender's withdraw, p2tr dust (330) on the recipient's transfer.
    assert.equal(quote.postageSats, 294 + 330)
    assert.equal(quote.walletPrompts, 4)
  })

  it('rejects bad arguments before any network call', async () => {
    const base = {
      tick: 'ordi',
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: true as const,
    }
    await expect(
      brc20.sendAsBrc20({ ...base, fromBrc20Amount: '0', fromProgAmount: '0' })
    ).rejects.toThrow(/both be 0/)
    await expect(
      brc20.sendAsBrc20({ ...base, fromBrc20Amount: '-1', fromProgAmount: '0' })
    ).rejects.toThrow(/fromBrc20Amount/)
    await expect(
      brc20.sendAsBrc20({
        ...base,
        recipient: 'bc1qnotanaddress',
        fromBrc20Amount: '1',
        fromProgAmount: '0',
      })
    ).rejects.toThrow(/recipient/)
    await expect(
      brc20.sendAsBrc20Prog({
        ...base,
        contractAddress: CONTRACT,
        topUpFromBrc20: '2',
        amount: 10n ** 18n,
      })
    ).rejects.toThrow(/exceed/)
    await expect(
      brc20.sendAsBrc20Prog({
        ...base,
        contractAddress: 'ordi',
        topUpFromBrc20: '0',
        amount: 10n ** 18n,
      })
    ).rejects.toThrow(/contractAddress/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('parseBrc20Amount', () => {
  it('scales decimal strings to 18 decimals', () => {
    expect(parseBrc20Amount('0', 'x')).toBe(0n)
    expect(parseBrc20Amount('12.5', 'x')).toBe(125n * 10n ** 17n)
    expect(parseBrc20Amount('0.000000000000000001', 'x')).toBe(1n)
  })
  it('rejects malformed amounts', () => {
    for (const bad of ['', '1.', '.5', '-1', '1e3', '0.0000000000000000001', ' 1'])
      expect(() => parseBrc20Amount(bad, 'x')).toThrow(/decimal string/)
  })
})
