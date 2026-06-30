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
      // Two flavours: browser (extensions + modal) and node/server (local wallet).
      entry: {
        browser: 'src/browser.ts',
        node: 'src/node.ts',
        core: 'src/core.ts',
        react: 'src/react.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['vue', 'react', 'react-dom'],
    },
  },
})
