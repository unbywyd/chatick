import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

/**
 * Отпечаток сборки в отдельном файле (SPEC §8.33).
 *
 * Приложение опрашивает его и, увидев чужую версию, предлагает перезагрузиться.
 * Без этого человек сидит на вчерашней версии, пока не догадается обновить
 * страницу сам — а догадываться он не обязан.
 */
function buildStamp() {
  const version = Date.now().toString(36)
  return {
    name: 'chatick-build-stamp',
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) })
    },
    config() {
      return { define: { __BUILD_VERSION__: JSON.stringify(version) } }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildStamp()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: { port: 5173 },
  // base './' — чтобы сборка работала и с nginx, и внутри Electron (file://)
  base: './',
})
