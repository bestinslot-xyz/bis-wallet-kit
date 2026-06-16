import { assert, describe, it } from 'vitest'
import * as kit from '../../src/main.ts'

// Guards the public API surface. A rename or dropped export (the main risk after
// the refactor) fails here instead of silently at a consumer's runtime.

const NAMESPACE_FUNCTIONS: Record<string, string[]> = {
  wallet: [
    'connect',
    'disconnect',
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
    'connectLocalWallet',
  ],
  modal: [
    'connect',
    'disconnect',
    'init',
    'create',
    'showConnect',
    'showConnectConfirmation',
    'showError',
    'hide',
    'setTheme',
  ],
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
    'withdraw',
    'tryGetSwapReferrerInfo',
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

// Exported at the top level (not under a namespace).
const TOP_LEVEL_FUNCTIONS = [
  'getEvmAddressFromBitcoinAddress',
  'getEvmAddressFromPkScript',
  'delegateInscription',
  'jsonInscription',
  'textInscription',
  'addressWalletInfo',
  'opReturnWalletInfo',
]

describe('public api surface', () => {
  for (const [ns, fns] of Object.entries(NAMESPACE_FUNCTIONS)) {
    describe(ns, () => {
      it(`is exported as a namespace`, () => {
        assert.ok((kit as any)[ns], `kit.${ns} is missing`)
      })
      for (const fn of fns) {
        it(`exposes ${fn}()`, () => {
          assert.equal(typeof (kit as any)[ns][fn], 'function', `kit.${ns}.${fn} is not a function`)
        })
      }
    })
  }

  describe('top-level helpers', () => {
    for (const fn of TOP_LEVEL_FUNCTIONS) {
      it(`exposes ${fn}()`, () => {
        assert.equal(typeof (kit as any)[fn], 'function', `kit.${fn} is not a function`)
      })
    }
  })

  describe('re-exports', () => {
    it('exposes bitcoinjs', () => {
      assert.ok(kit.bitcoinjs?.networks?.bitcoin)
    })
    it('exposes Buff', () => {
      assert.ok(kit.Buff)
    })
  })
})
