import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 90000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
    // Starting processes is far slower on Windows, and every action here starts several.
    expect: { poll: { timeout: 20000 } }
  }
})
