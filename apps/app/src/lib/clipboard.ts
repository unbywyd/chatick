// Извлечение файлов из буфера обмена (SPEC §8.16).
// Возвращает File[] из paste-события: картинки из буфера получают осмысленное имя.

export function filesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []

  // 1) прямые файлы (скопированный файл в проводнике)
  for (const f of Array.from(dt.files)) out.push(f)

  // 2) элементы-картинки (скриншот из буфера) — приходят через items как kind:'file'
  if (out.length === 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) {
          // у скриншотов часто пустое имя — генерируем
          const ext = f.type.split('/')[1] || 'png'
          out.push(f.name ? f : new File([f], `pasted-image.${ext}`, { type: f.type }))
        }
      }
    }
  }
  return out
}

/** Короткое превью текста из буфера: пара строк + многоточие. */
export function textPreview(text: string, maxLines = 2, maxChars = 120): string {
  const lines = text.split('\n').slice(0, maxLines)
  let s = lines.join('\n').slice(0, maxChars)
  if (text.length > s.length) s += '…'
  return s
}

export type ClipboardContent =
  | { kind: 'image'; files: File[]; previewUrl: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'denied' }

/** Читает системный буфер (async Clipboard API). Требует жеста пользователя / разрешения. */
export async function readClipboard(): Promise<ClipboardContent> {
  try {
    if (navigator.clipboard && 'read' in navigator.clipboard) {
      const items = await navigator.clipboard.read()
      const files: File[] = []
      for (const item of items) {
        const imgType = item.types.find((ty) => ty.startsWith('image/'))
        if (imgType) {
          const blob = await item.getType(imgType)
          files.push(new File([blob], `pasted-image.${imgType.split('/')[1] || 'png'}`, { type: imgType }))
        }
      }
      if (files.length) return { kind: 'image', files, previewUrl: URL.createObjectURL(files[0]!) }
    }
    const text = await navigator.clipboard.readText().catch(() => '')
    return text ? { kind: 'text', text } : { kind: 'empty' }
  } catch {
    return { kind: 'denied' }
  }
}
