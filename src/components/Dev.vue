<!-- eslint-disable no-console -->
<script setup lang="ts">
import type { BISSession, BISWallet } from '../types/common'
import { Script } from '@cmdcode/tapscript'
import { computed, onMounted, ref } from 'vue'
import { useNetwork } from '../adapters/vue/use-network'
import * as bis from '../browser'
import BRC20 from './dev/BRC20.vue'
import Button from './dev/Button.vue'
import Select from './dev/Select.vue'
import SessionInfo from './dev/SessionInfo.vue'
import '../assets/style/dev.css'

export interface DevUserSession {
  data: BISSession
  wallet: {
    ordinals: BISWallet
    payment: BISWallet
  }
  balance: number
}

const network = useNetwork()
const session = ref<DevUserSession>()
const isConnected = computed(() => !!session.value)

onMounted(async () => {
  // Init once on app mount
  bis.modal.init()

  // Force a theme (default is system)
  bis.modal.setTheme('dark')

  // Get locally stored wallet info
  const data = bis.wallet.getSession()

  if (data)
    onWalletConnect(data)

  testCustomTapscript()
})

async function onConnectClick() {
  const data = await bis.wallet.connect().catch((e) => {
    console.error(e)
    return null
  })

  if (data) {
    onWalletConnect(data)
  }
  else {
    console.error('Connection failed')
  }
}

function onWalletConnect(currentSession: BISSession) {
  console.log('Session Data:', currentSession)

  const ordinalsWallet = bis.wallet.getOrdinalsWallet()
  const paymentWallet = bis.wallet.getPaymentWallet()

  if (!ordinalsWallet || !paymentWallet) {
    console.error('No wallets found')
    return
  }

  // Set component state
  session.value = {
    data: currentSession,
    wallet: {
      ordinals: ordinalsWallet,
      payment: paymentWallet,
    },
    balance: 0,
  }

  // Get balance
  getBalance()
}

function onDisconnectClick() {
  // Disconnect from wallet
  bis.wallet.disconnect()

  // Component state
  session.value = undefined
}

async function getBalance() {
  if (!session.value)
    return

  session.value.balance = await bis.wallet.getCardinalBalance(session.value.wallet.payment.address)
}

const networkOpts = [
  { value: 'mainnet', label: 'Mainnet' },
  { value: 'testnet', label: 'Testnet4' },
  { value: 'signet', label: 'Signet' },
]

function testCustomTapscript() {
  const script = Script.encode([1])
  const isOriginal = script[0] === 0x51 // 0x51 = OP_1

  console.log('Encoded:', [...script])

  if (isOriginal) {
    console.log('❌ Tapscript: Still using original opcode logic (1 → OP_1)')
  }
  else {
    console.log('✅ Tapscript: Custom logic confirmed (1 encoded as literal value) ')
  }
}
</script>

<template>
  <div class="bg-background min-h-full flex flex-col font-sans text-foreground">
    <div class="mx-auto max-w-4xl border-x border-border border-dashed flex-1 w-full pb-24">
      <!-- DEV -->
      <div class="border-b border-border border-dashed p-2 flex items-center gap-x-4">
        <img src="/src/assets/dev/chest-dark-bg.png" class="w-12 h-12">
        <h1 class="text-2xl font-bold">
          BiS Wallet Kit - DEV
        </h1>
      </div>

      <!-- Guest Functions -->
      <div class="border-b border-border border-dashed p-4 flex gap-x-2">
        <Button @click="onConnectClick()">
          Connect Wallet
        </Button>
        <Select v-model="network" :options="networkOpts" />
      </div>

      <!-- Session Actions -->
      <div v-if="isConnected" class="border-b border-border border-dashed p-4">
        <Button @click="onDisconnectClick()">
          Disconnect
        </Button>
      </div>

      <!-- BRC20 -->
      <div v-if="isConnected" class="border-b border-border border-dashed p-4">
        <BRC20 />
      </div>

      <!-- Session INFO -->
      <SessionInfo :session="session" />
    </div>
  </div>
</template>
