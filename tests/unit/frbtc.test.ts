import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { ethers } from 'ethers'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { callInscription, opReturnTarget, runChain } from '../../src/core/brc20-send.ts'
import { compressSmartContractData } from '../../src/core/brc20.ts'
import { balances, brc20, getEvmAddressFromBitcoinAddress, wallet } from '../../src/node.ts'
import { textInscription } from '../../src/types/inscription.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const PAYER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const RECIPIENT = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const FRBTC = '0x1eb63d0d0e5a86146b4e1cebc79b1d6e35093288'
const SIGNER_SCRIPT = Buffer.from(
  '512087e39e8a44acfb216fd991618ad0c346b4ba3a23ec45fb8b4a22e805dbf6be23',
  'hex'
)

const net = bitcoin.networks.testnet
const payerScript = bitcoin.address.toOutputScript(PAYER, net)
const recipientScript = bitcoin.address.toOutputScript(RECIPIENT, net)
const opReturnScript = bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN!,
  Buffer.from('BRC20PROG'),
])
const abi = ethers.AbiCoder.defaultAbiCoder()

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

let frBtcBalance: bigint
const ethCalls: { to: string; data: string }[] = []
const broadcastBodies: string[][] = []
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

function witnessHex(tx: bitcoin.Transaction): string {
  return tx.ins.flatMap(i => i.witness.map(w => w.toString('hex'))).join('')
}

function inputsOf(tx: bitcoin.Transaction): string[] {
  return tx.ins.map(i => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`)
}

async function callContentHex(calldata: string): Promise<string> {
  const content = `{"p":"brc20-prog","op":"c","c":"${FRBTC}","b":"${await compressSmartContractData(calldata)}"}`
  return Buffer.from(content).toString('hex')
}

function broadcastTxes(): bitcoin.Transaction[] {
  return broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h))
}

describe('frBTC on the BRC2.0 address', () => {
  beforeEach(async () => {
    const txid = 'aa'.repeat(32)
    const utxos = [fakeCardinalUtxo(txid, 200000)]
    const prevHexByTxid: Record<string, string> = { [txid]: prevTxHex(200000) }
    frBtcBalance = 5000n
    ethCalls.length = 0
    broadcastBodies.length = 0

    fetchMock = vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('rpc-signet.brc20.build')) {
        const { to, data } = JSON.parse(opts.body).params[0]
        ethCalls.push({ to, data })
        if (data.startsWith(ethers.id('getSignerAddress()').slice(0, 10)))
          return jsonResponse({ result: abi.encode(['bytes'], [SIGNER_SCRIPT]) })
        if (data.startsWith(ethers.id('balanceOf(address)').slice(0, 10)))
          return jsonResponse({ result: abi.encode(['uint256'], [frBtcBalance]) })
      }
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

    await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getFrBtcAddress follows the selected network', async () => {
    assert.equal(brc20.getFrBtcAddress(), FRBTC)
    await wallet.setNetwork('mainnet')
    assert.equal(brc20.getFrBtcAddress(), '0xdbb5b6a1d422fca2813cf486e5f986adb09d8337')
    await wallet.setNetwork('testnet')
    expect(() => brc20.getFrBtcAddress()).toThrow(/not deployed on testnet/)
  })

  it('reads the balance with balanceOf on the BRC2.0 address', async () => {
    assert.equal(await balances.getFrBtcBalanceOfAddress(PAYER), 5000n)
    const call = ethCalls.at(-1)!
    assert.equal(call.to, FRBTC)
    assert.equal(
      call.data,
      ethers.id('balanceOf(address)').slice(0, 10) +
        abi.encode(['address'], [getEvmAddressFromBitcoinAddress(PAYER)]).slice(2)
    )
  })

  it('wrap calls wrap() and pays the amount to the signer at vout 1', async () => {
    const prompts: { step: number; total?: number }[] = []
    const res = await brc20.wrapBtcToBrc20Prog({
      amount: 12345n,
      feeRate: 2,
      dryRun: false,
      onSignRequest: r => prompts.push(r),
    })

    const txes = broadcastTxes()
    assert.equal(txes.length, 3)
    const send = txes[2]!
    assert.ok(send.outs[0]!.script.equals(opReturnScript))
    assert.ok(send.outs[1]!.script.equals(SIGNER_SCRIPT))
    assert.equal(send.outs[1]!.value, 12345)
    assert.include(witnessHex(txes[1]!), await callContentHex(ethers.id('wrap()').slice(0, 10)))
    assert.equal(res.call.sendTxId, send.getId())
    assert.deepEqual(
      res.txIds,
      txes.map(t => t.getId())
    )
    assert.deepEqual(
      prompts.map(p => p.step),
      [1, 2]
    )
  })

  it('unwrap calls unwrap2(amount, 1, recipientScript) with a 546-sat signer marker', async () => {
    await brc20.unwrapBtcFromBrc20Prog({
      amount: 4000n,
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: false,
    })

    const txes = broadcastTxes()
    const send = txes[2]!
    assert.ok(send.outs[0]!.script.equals(opReturnScript))
    assert.ok(send.outs[1]!.script.equals(SIGNER_SCRIPT))
    assert.equal(send.outs[1]!.value, 546)
    const calldata =
      ethers.id('unwrap2(uint256,uint256,bytes)').slice(0, 10) +
      abi.encode(['uint256', 'uint256', 'bytes'], [4000n, 1n, recipientScript]).slice(2)
    assert.include(witnessHex(txes[1]!), await callContentHex(calldata))
  })

  it('unwrap refuses an amount above the BRC2.0 balance before signing', async () => {
    await expect(
      brc20.unwrapBtcFromBrc20Prog({
        amount: 5001n,
        recipient: RECIPIENT,
        feeRate: 2,
        dryRun: false,
      })
    ).rejects.toThrow(/Insufficient BRC2.0 frBTC balance/)
    assert.equal(broadcastBodies.length, 0)
  })

  it('dryRun quotes count the wrapped amount as a payment', async () => {
    const wrap = await brc20.wrapBtcToBrc20Prog({ amount: 10000n, feeRate: 2, dryRun: true })
    assert.equal(wrap.paymentSats, 10000)
    assert.equal(wrap.postageSats, 1)
    assert.equal(wrap.totalSats, wrap.minerFeeSats + wrap.postageSats + wrap.paymentSats)
    assert.deepEqual(
      wrap.steps.map(s => s.step),
      ['frBtcWrap']
    )

    const unwrap = await brc20.unwrapBtcFromBrc20Prog({
      amount: 1000n,
      recipient: RECIPIENT,
      feeRate: 2,
      dryRun: true,
    })
    assert.equal(unwrap.paymentSats, 546)
    assert.equal(broadcastBodies.length, 0)
  })

  it('rejects bad arguments before any network call', async () => {
    await expect(
      brc20.wrapBtcToBrc20Prog({ amount: 545n, feeRate: 2, dryRun: true })
    ).rejects.toThrow(/at least 546/)
    await expect(
      brc20.unwrapBtcFromBrc20Prog({ amount: 0n, recipient: RECIPIENT, feeRate: 2, dryRun: true })
    ).rejects.toThrow(/at least 1/)
    await expect(
      brc20.unwrapBtcFromBrc20Prog({
        amount: 1000n,
        recipient: 'bc1qnotanaddress',
        feeRate: 2,
        dryRun: true,
      })
    ).rejects.toThrow(/recipient/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('chain steps with extra outputs', () => {
  beforeEach(async () => {
    const txid = 'bb'.repeat(32)
    broadcastBodies.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, opts?: any) => {
        const u = String(url)
        if (u.includes('/cardinal_utxos/'))
          return jsonResponse({ data: [fakeCardinalUtxo(txid, 200000)] })
        if (u.includes('/gettxhex/')) return jsonResponse(prevTxHex(200000))
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
    )
    await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts extra outputs before the link output the next commit spends', async () => {
    const signer = new WalletInfo(false, SIGNER_SCRIPT, null, null, null)
    await runChain(
      [
        {
          name: 'frBtcWrap',
          inscription: textInscription('first'),
          target: opReturnTarget(),
          extraOutputs: [{ wallet: signer, value: 777 }],
        },
        { name: 'progTransfer', inscription: textInscription('second'), target: opReturnTarget() },
      ],
      2,
      false,
      {}
    )
    const txes = broadcastTxes()
    const firstSend = txes[2]!
    assert.ok(firstSend.outs[1]!.script.equals(SIGNER_SCRIPT))
    assert.equal(firstSend.outs[1]!.value, 777)
    assert.ok(firstSend.outs[2]!.script.equals(payerScript))
    assert.equal(firstSend.outs[2]!.value, 1000)
    assert.include(inputsOf(txes[3]!), `${firstSend.getId()}:2`)
  })

  it('refuses a send that spends more inputs than the step allows, before broadcast', async () => {
    await expect(
      runChain(
        [
          {
            name: 'frBtcWrap',
            inscription: textInscription('call'),
            target: opReturnTarget(),
            maxSendInputs: 0,
          },
        ],
        2,
        false,
        {}
      )
    ).rejects.toThrow(/spends \d+ inputs, more than the 0 its gas covers/)
    assert.equal(broadcastBodies.length, 0)
  })
})

describe('callInscription', () => {
  it('pads the content until its bytes grant the gas ceiling', async () => {
    const ceiling = 4_000_000
    const details = await callInscription(FRBTC, ethers.id('wrap()').slice(0, 10), ceiling)
    const content = Buffer.from(details.data!)
    assert.isAtLeast(content.length * 12000, ceiling)
    assert.isBelow((content.length - 1) * 12000, ceiling)
    assert.match(content.toString(), /^\{"p":"brc20-prog","op":"c","c":"0x1eb6[^}]+\} +$/)
  })
})
