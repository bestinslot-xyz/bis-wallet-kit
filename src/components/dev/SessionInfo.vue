<script setup lang="ts">
import type { DevUserSession } from '../Dev.vue'
import { computed } from 'vue'
import { useNetwork } from '../../core/store-network'

const props = defineProps<{
  session: DevUserSession | undefined
}>()

const network = useNetwork()
const isConnected = computed(() => !!props.session)
</script>

<template>
  <div class="bg-black/20 p-2 overflow-x-auto">
    <div>
      <span class="font-semibold text-primary">network:</span> {{ network }}
    </div>
    <div>
      <span class="font-semibold text-primary">connected:</span> {{ isConnected ? 'true' : 'false' }}
    </div>
    <div>
      <span class="font-semibold text-primary">balance:</span> {{ session ? `${session.balance / 1e8} BTC` : '' }}
    </div>
    <div>
      <span class="font-semibold text-primary">session:</span>
      <div class="text-sm whitespace-pre" :class="{ 'inline ml-1': !session }">
        {{ session?.data || 'N/A' }}
      </div>
    </div>
    <div>
      <span class="font-semibold text-primary">ordinals wallet:</span>
      <div class="text-sm whitespace-pre" :class="{ 'inline ml-1': !session?.wallet.ordinals }">
        {{ session?.wallet.ordinals || 'N/A' }}
      </div>
    </div>
    <div>
      <span class="font-semibold text-primary">payment wallet:</span>
      <div class="text-sm whitespace-pre" :class="{ 'inline ml-1': !session?.wallet.payment }">
        {{ session?.wallet.payment || 'N/A' }}
      </div>
    </div>
  </div>
</template>
