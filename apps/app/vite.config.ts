import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

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

/**
 * Панель трея выкладывается вместе с вебом.
 *
 * Приложение грузит её с сайта (LOAD_MODE = 'remote'), чтобы правки доезжали
 * без переустановки — половина обновлений оболочки это она. Но исходник лежит
 * в apps/desktop, в сборку приложения не входит, и на сервере годами жила
 * копия, положенная руками в public/. Vite чистит dist при каждой сборке, так
 * что источником правды оставалась именно та копия — и расходилась с
 * репозиторием молча: панель в гите новая, у людей старая.
 *
 * Копируем на сборке, а не руками: единственный способ не забыть.
 */
function panelHtml() {
  return {
    name: 'chatick-panel',
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      const src = path.resolve(__dirname, '../desktop/panel.html')
      // Нет файла — падаем: молча выложенная сборка без панели означает, что
      // у всех в трее осталась вчерашняя разметка, и понять это неоткуда.
      this.emitFile({ type: 'asset', fileName: 'panel.html', source: readFileSync(src, 'utf8') })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildStamp(), panelHtml()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: { port: 5173 },
  // base './' — чтобы сборка работала и с nginx, и внутри Electron (file://)
  base: './',
})
