/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Отпечаток сборки — подставляется vite (см. vite.config.ts). */
declare const __BUILD_VERSION__: string
