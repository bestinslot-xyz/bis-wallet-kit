<script setup lang="ts">
import type { BISWalletProvider } from '../types/common'
import type { ConnectCallbacks, ModalState, ModalTheme } from '../types/common'
import { computed, nextTick, ref } from 'vue'
import errorImage from '../assets/img/error.png'
import leatherLogo from '../assets/img/provider/leather.png'
import meLogo from '../assets/img/provider/me.png'
import okxLogo from '../assets/img/provider/okx.png'
import unisatLogo from '../assets/img/provider/unisat.png'
import xverseLogo from '../assets/img/provider/xverse.png'
import wooGIF from '../assets/img/woo.gif'
import { getWallets } from '../core/providers'

const theme = ref<ModalTheme>('system')
const visible = ref(false)
const state = ref<ModalState>('connect')
const errorMessage = ref<string>()
const provider = ref<BISWalletProvider>()
const providerList = ref<HTMLElement>()

const providers: Partial<Record<BISWalletProvider, { name: string; img: string }>> = {
  okx: {
    name: 'OKX',
    img: okxLogo,
  },
  unisat: {
    name: 'Unisat',
    img: unisatLogo,
  },
  xverse: {
    name: 'Xverse',
    img: xverseLogo,
  },
  leather: {
    name: 'Leather',
    img: leatherLogo,
  },
  me: {
    name: 'Magic Eden',
    img: meLogo,
  },
}

const links = {
  terms: 'https://bestinslot.xyz/legal/terms',
  privacy: 'https://bestinslot.xyz/legal/privacy',
  api: 'https://bestinslot.xyz/api',
}

const providerObj = computed(() => {
  if (!provider.value) return undefined

  return providers[provider.value]
})

let connectCallbacks: ConnectCallbacks | null = null

async function showConnect(callbacks: ConnectCallbacks) {
  errorMessage.value = undefined
  state.value = 'connect'
  visible.value = true

  connectCallbacks = callbacks

  await nextTick()

  // Focus the first button in the modal
  const firstButton = providerList.value?.querySelector('button')
  firstButton?.focus()
}

function showConnectConfirmation(_provider: BISWalletProvider) {
  errorMessage.value = undefined
  state.value = 'confirm_connection'
  visible.value = true
  provider.value = _provider
}

function showError(message: string) {
  state.value = 'error'
  errorMessage.value = message
  visible.value = true
}

function hide() {
  visible.value = false
}

function setTheme(_theme: ModalTheme) {
  theme.value = _theme
}

function onCloseClick() {
  visible.value = false
  errorMessage.value = undefined
  connectCallbacks?.onError(new Error('User closed the modal.'))
}

function onRetryConnectClick() {
  errorMessage.value = undefined
  state.value = 'connect'
  visible.value = true
}

async function onProviderSelect(providerName: BISWalletProvider) {
  // Show confirmation screen
  showConnectConfirmation(providerName)

  try {
    // succcess
    const data = await getWallets(providerName)

    if (!data) throw new Error(`Could not get wallets from the provider:${providerName}`)

    // Resolve the promise with the data
    connectCallbacks?.onSelect(data)

    // Hide the modal
    visible.value = false
  } catch (error: any) {
    console.error('Error connecting to provider.')
    console.error(error)

    showError(error?.message)
  }
}

// expose functions for external control
defineExpose({ showConnect, showError, showConnectConfirmation, hide, setTheme })
</script>

<template>
  <Transition name="fade-scale" appear>
    <div
      v-if="visible"
      class="z-10 sm:z-50 fixed inset-0 flex justify-center items-center bg-black/90 font-sans"
      :class="[
        { 'bis-cw-theme-light': theme === 'light' },
        { 'bis-cw-theme-dark': theme === 'dark' },
      ]"
    >
      <div
        class="flex flex-col max-h-[90vh] bg-background shadow-lg border border-border rounded-lg w-[92%] max-w-sm text-foreground"
      >
        <!-- Header -->
        <div class="relative flex justify-between items-center p-4 py-3 border-b border-border">
          <div class="font-semibold text-lg">Connect Wallet</div>
          <button
            class="top-2 right-3 absolute flex -m-2 p-2 text-muted-foreground hover:text-foreground text-2xl transition-colors cursor-pointer"
            @click="onCloseClick"
          >
            &times;
          </button>
        </div>

        <!-- Body -->
        <div class="overflow-y-auto px-4 sm:px-6 py-6 best-scrollbar">
          <!-- SCREEN: CONNECT -->
          <div v-if="state === 'connect'">
            <div class="mb-6 font-medium text-xl text-center">Select your Bitcoin wallet</div>
            <div ref="providerList" class="flex flex-col gap-y-3">
              <!-- Provider List -->
              <button
                v-for="(item, key) in providers"
                :key="key"
                class="group flex items-center gap-x-4 p-2 border hover:border-primary border-border rounded-lg w-full text-left transition-colors cursor-pointer duration-300"
                @click="onProviderSelect(key)"
              >
                <img :src="item?.img" class="rounded-lg size-10" />
                <div class="font-semibold text-lg grow">
                  {{ item?.name }}
                </div>
                <svg
                  class="w-auto h-6 text-muted-foreground group-hover:text-foreground transition-colors duration-300"
                  xmlns="http://www.w3.org/2000/svg"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="m9 18l6-6l-6-6"
                  />
                </svg>
              </button>
            </div>
          </div>
          <!-- SCREEN: CONFIRM CONNECTION -->
          <div v-else-if="state === 'confirm_connection'">
            <div class="mb-6 font-medium text-xl text-center">
              Confirm connection on {{ providerObj?.name }}
            </div>
            <div class="mx-auto mb-4 max-w-50 text-muted-foreground text-center">
              Check your extension and confirm the connection...
            </div>
            <img :src="wooGIF" class="mx-auto size-16" />
          </div>
          <!-- SCREEN: ERROR -->
          <div v-else-if="state === 'error'">
            <div class="text-center">
              <img :src="errorImage" class="mx-auto mb-8 w-9 h-9.75" />

              <div class="mb-8 text-center">
                {{ errorMessage }}
              </div>

              <button
                class="hover:bg-primary border border-border rounded-lg w-24 h-10 font-semibold text-foreground text-lg text-center transition-colors cursor-pointer"
                @click="onRetryConnectClick"
              >
                Retry
              </button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="p-4 border-t border-border text-muted-foreground text-center">
          <div class="mb-2">
            Powered by
            <a
              class="font-medium text-foreground hover:underline underline-offset-4"
              :href="links.api"
              target="_blank"
              >BiS API</a
            >
          </div>
          <div class="text-sm">
            By connecting your wallet, you agree to Best in Slot's
            <a
              class="text-foreground hover:underline underline-offset-4"
              :href="links.terms"
              target="_blank"
              >Terms of Service</a
            >
            and
            <a
              class="text-foreground hover:underline underline-offset-4"
              :href="links.privacy"
              target="_blank"
              >Privacy Policy</a
            >.
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
