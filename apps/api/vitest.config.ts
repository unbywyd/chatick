import { defineConfig } from 'vitest/config'

// Только исходники: без этого vitest находит ещё и скомпилированные копии в
// dist/ и гоняет каждый тест дважды — числа в отчёте перестают что-либо значить.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
