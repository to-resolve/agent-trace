import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 纯客户端工具，无 SSR；产物为静态文件，可直接部署（见 docs/01 技术选型）。
// 覆盖率只考核 src/core/**（T3 审查裁决 2）：
// render/ 靠压测、ui/ 靠目视，都不纳入覆盖率口径。
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**'],
      exclude: ['**/*.test.ts'],
    },
  },
})
