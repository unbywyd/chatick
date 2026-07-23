import { defineConfig } from 'astro/config'

// Статический пререндер: / (en), /ru/, /he/ — каждая локаль своя страница (SEO + hreflang).
export default defineConfig({
  site: 'https://chatick.com',
  output: 'static',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ru', 'he'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
})
