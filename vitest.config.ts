import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Default config: offline unit tests. No network, no secrets — safe for CI.
// Network integration suites use vitest.signet.config.ts / vitest.mainnet.config.ts.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
