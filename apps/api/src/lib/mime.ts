/**
 * Тип файла, когда загрузчик его не назвал.
 *
 * Оба пути загрузки хранили `file.type || 'application/octet-stream'`, а тип
 * не приходит чаще, чем кажется: ассистент через мост шлёт байты без него.
 * На проде так легло 36 картинок `.png` с типом octet-stream — и всё, что
 * решает «это картинка» по mime, их не узнавало: ни миниатюры в карточке, ни
 * лайтбокс, ни фильтр «изображения» в файлах. Человек видел иконку файла и
 * кнопку «скачать» там, где у соседнего файла была картинка.
 *
 * Чиним на сервере, а не в каждом загрузчике: путей три (интерфейс, мост,
 * файлы ресурсов), и правило, выписанное трижды, разошлось бы. Расширение —
 * не доказательство, но octet-stream — это признание «не знаю», и догадка по
 * имени заведомо лучше него.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const GENERIC_MIME = 'application/octet-stream'

/** Тип по расширению имени — или null, если расширение неизвестно. */
export function mimeFromName(name: string): string | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return ext ? (MIME_BY_EXT[ext] ?? null) : null
}

/**
 * Тип, который кладём в базу: названный загрузчиком, если он что-то значит;
 * иначе — по имени; иначе — честное «не знаю».
 *
 * Названный тип побеждает: `image/webp` у файла `.png` после пережатия —
 * правда о байтах, а имя — история.
 */
export function resolveMime(given: string | null | undefined, name: string): string {
  const g = (given ?? '').trim().toLowerCase()
  if (g && g !== GENERIC_MIME) return g
  return mimeFromName(name) ?? GENERIC_MIME
}
