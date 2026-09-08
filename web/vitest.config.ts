import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The ffmpeg suite spawns real encodes; it runs only when asked for.
    exclude: process.env.FFWEB_TEST_FFMPEG
      ? ['node_modules/**']
      : ['node_modules/**', 'src/**/*.ffmpeg.test.ts'],
    testTimeout: process.env.FFWEB_TEST_FFMPEG ? 180_000 : 5_000,
    hookTimeout: 120_000,
  },
})
