import { assert, describe, it } from 'vitest'
import * as browser from '../../src/browser.ts'
import * as node from '../../src/node.ts'

// Guards the public API surface of both build flavours (#8). A rename, dropped
// export, or a symbol leaking into the wrong flavour fails here instead of at a
// consumer's runtime.

// Present on the wallet namespace in both flavours.
const SHARED_WALLET_FNS = [
  'getAllBalanceDetails',
  'getCardinalBalance',
  'getNetwork',
  'getOrdinalsWallet',
  'getPaymentWallet',
  'getSession',
  'sendBTC',
  'sendInscription',
  'setNetwork',
  'signMessage',
  'signMessageLocalVerify',
  'signMessageLocalVerifyDeterministic',
]

// Feature namespaces present in both flavours.
const SHARED_NAMESPACES: Record<string, string[]> = {
  swap: [
    'createSwapWallet',
    'getAddLiquidityResult',
    'getKlines',
    'getMinerFee',
    'getMinerFeesOfDepositOrder',
    'getMinerFeesOfWrapOrder',
    'getPairReserves',
    'getPairVolumeOverDays',
    'getRemoveLiquidityResult',
    'getSwapExactOutputResult',
    'getSwapBalance',
    'getSwapBalances',
    'getSwapExactInputResult',
    'getSwapStatus',
    'getTokenDecimals',
    'getUnwrapResult',
    'getPairAddress',
    'getWalletActivities',
    'getActivityOfPair',
    'addLiquidity',
    'removeLiquidity',
    'swapExactInput',
    'swapExactOutput',
    'unwrap',
    'deposit',
    'wrapBtc',
    'withdraw',
    'tryGetSwapReferrerInfo',
    'swapSide',
    'satsToBtc',
    'satsToUsd',
  ],
  brc20: ['callSmartContract', 'callSmartContractAbi', 'depositToBrc20Prog', 'withdrawFromBrc20Prog'],
  mint: ['inscribe', 'inscribeMultiple', 'inscribeWithParent', 'getInscribeFee', 'getInscribeMultipleFee'],
  balances: [
    'getBaseBRC20BalanceOfAddress',
    'getBRC20ProgBalanceOfAddress',
    'getBRC20ProgBalanceOfTicker',
    'getBRC20ProgTokenAddressOfTicker',
  ],
}

const SHARED_TOP_LEVEL_FNS = [
  'getEvmAddressFromBitcoinAddress',
  'getEvmAddressFromPkScript',
  'delegateInscription',
  'jsonInscription',
  'textInscription',
  'addressWalletInfo',
  'opReturnWalletInfo',
]

const MODAL_FNS = [
  'connect',
  'disconnect',
  'init',
  'create',
  'showConnect',
  'showConnectConfirmation',
  'showError',
  'hide',
  'setTheme',
]

function assertFn(obj: any, name: string, path: string) {
  assert.equal(typeof obj?.[name], 'function', `${path} is not a function`)
}

for (const { name, kit } of [{ name: 'node', kit: node }, { name: 'browser', kit: browser }] as const) {
  describe(`shared surface (${name})`, () => {
    for (const fn of SHARED_WALLET_FNS) {
      it(`wallet.${fn}()`, () => assertFn((kit as any).wallet, fn, `${name}.wallet.${fn}`))
    }
    for (const [ns, fns] of Object.entries(SHARED_NAMESPACES)) {
      for (const fn of fns) {
        it(`${ns}.${fn}()`, () => assertFn((kit as any)[ns], fn, `${name}.${ns}.${fn}`))
      }
    }
    for (const fn of SHARED_TOP_LEVEL_FNS) {
      it(`${fn}()`, () => assertFn(kit, fn, `${name}.${fn}`))
    }
    it('re-exports bitcoinjs + Buff', () => {
      assert.ok((kit as any).bitcoinjs?.networks?.bitcoin)
      assert.ok((kit as any).Buff)
    })
  })
}

describe('node flavour specifics', () => {
  it('wallet exposes connectLocalWallet', () => assertFn(node.wallet, 'connectLocalWallet', 'node.wallet.connectLocalWallet'))
  it('wallet has no modal connect/disconnect', () => {
    assert.equal((node.wallet as any).connect, undefined)
    assert.equal((node.wallet as any).disconnect, undefined)
  })
  it('has no modal namespace', () => {
    assert.equal((node as any).modal, undefined)
  })
})

describe('browser flavour specifics', () => {
  it('wallet exposes connect/disconnect', () => {
    assertFn(browser.wallet, 'connect', 'browser.wallet.connect')
    assertFn(browser.wallet, 'disconnect', 'browser.wallet.disconnect')
  })
  it('wallet has no connectLocalWallet', () => {
    assert.equal((browser.wallet as any).connectLocalWallet, undefined)
  })
  for (const fn of MODAL_FNS) {
    it(`modal.${fn}()`, () => assertFn(browser.modal, fn, `browser.modal.${fn}`))
  }
})
