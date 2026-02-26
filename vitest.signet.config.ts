import vue from '@vitejs/plugin-vue'
import * as dotenv from 'dotenv'
import { defineConfig } from 'vitest/config'

dotenv.config({ path: '.env.signet' })

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/signet/*.ts'],
  },
})
