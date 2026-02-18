import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    wasm(),
    vue(),
    tailwindcss(),
    nodePolyfills(),
    dts({
      tsconfigPath: './tsconfig.app.json',
      outDir: 'dist/types',
      copyDtsFiles: true,
    }),
  ],
  resolve: {
    alias: {
      '@@': fileURLToPath(new URL('./src', import.meta.url)), // Alias for src folder
    },
  },
  optimizeDeps: {
    exclude: ['@bokuweb/zstd-wasm'],
    esbuildOptions: {
      target: 'es2020',
    },
  },
  build: {
    cssCodeSplit: false, // bundle all CSS into one file
    assetsInlineLimit: 1024 * 50, // 50kb
    lib: {
      entry: 'src/main.ts',
      name: 'BIS_CW',
      fileName: 'bis-wallet-kit',
      formats: ['es'], // iife for browser, es for node
    },
    rollupOptions: {
      external: ['vue'],
    },
  },
})
