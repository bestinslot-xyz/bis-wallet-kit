<script setup lang="ts">
import { cn } from '../../lib/dev'

const props = defineProps<{
  options: Option[]
  class?: string
}>()

const model = defineModel<string>({ default: '' })

interface Option {
  value: string
  label: string
}
</script>

<template>
  <select
    v-model="model"
    :class="
      cn(
        'inline-flex items-center bg-background px-2 border border-border rounded focus:outline-none focus:border-primary ring-0 h-10 text-foreground text-sm appearance-none cursor-pointer',
        props.class
      )
    "
  >
    <option v-if="options.length === 0" disabled value="" class="bg-amber-300 disabled:bg-black">
      Select
    </option>
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
