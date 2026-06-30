import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [vue(), wasm(), nodePolyfills()],
  optimizeDeps: { exclude: ['@bokuweb/zstd-wasm'] },
})
