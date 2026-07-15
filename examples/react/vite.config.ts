import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [react(), wasm(), nodePolyfills()],
  optimizeDeps: { exclude: ['@bokuweb/zstd-wasm'] },
})
