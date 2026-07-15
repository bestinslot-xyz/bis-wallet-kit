<script setup lang="ts">
import { modal, wallet } from '@bestinslot/wallet-kit'
import { useNetwork } from '@bestinslot/wallet-kit/vue'
import { ref } from 'vue'

const network = useNetwork()
const session = ref(wallet.getSession())

async function connect() {
  try {
    await modal.connect()
    session.value = wallet.getSession()
  }
  catch (e) {
    console.error('Connection failed:', e)
  }
}

function disconnect() {
  wallet.disconnect()
  session.value = wallet.getSession()
}
</script>

<template>
  <main>
    <h1>BiS Wallet Kit — Vue</h1>
    <button type="button" @click="connect">
      Connect
    </button>
    <button type="button" @click="disconnect">
      Disconnect
    </button>
    <select v-model="network">
      <option value="mainnet">
        mainnet
      </option>
      <option value="testnet">
        testnet
      </option>
      <option value="signet">
        signet
      </option>
    </select>
    <pre>{{ session ? JSON.stringify(session, null, 2) : 'Not connected' }}</pre>
  </main>
</template>
