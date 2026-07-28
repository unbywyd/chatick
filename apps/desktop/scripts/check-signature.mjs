// Проверка подписи после сборки.
//
// electron-builder печатает «signing with signtool.exe» и тогда, когда
// сертификата нет: шаг просто пропускается, сборка идёт дальше. Из-за этого
// несколько релизов ушло к людям неподписанными — в логе всё выглядело
// правильно, а Windows показывала «неизвестный издатель».
//
// Здесь проверяется результат, а не намерение: кто подписал и до какого числа.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Спрашиваем саму Windows: она и будет судить о подписи у пользователя. */
function signatureOf(file) {
  if (process.platform !== 'win32') return { status: 'skip' }
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$s = Get-AuthenticodeSignature '${file}'; ` +
          `Write-Output $s.Status; ` +
          `Write-Output $s.SignerCertificate.Subject; ` +
          `Write-Output $s.SignerCertificate.NotAfter`,
      ],
      { encoding: 'utf8' },
    )
    const [status, subject, until] = out.split(/\r?\n/)
    return { status, subject, until }
  } catch (e) {
    return { status: 'unknown', error: String(e) }
  }
}

/**
 * Панель лежит в двух местах: вшитая (запасная, для работы без сети) и та,
 * что раздаётся с сайта. Разойдясь, они дают неповторимые баги — у одного
 * человека панель с сайта, у другого вшитая, и ведут себя они по-разному.
 */
function checkPanelCopies() {
  const a = path.join(process.cwd(), 'panel.html')
  const b = path.join(process.cwd(), '..', 'app', 'public', 'panel.html')
  if (!existsSync(a) || !existsSync(b)) return
  if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) {
    console.log(
      '\n  ВНИМАНИЕ: apps/desktop/panel.html и apps/app/public/panel.html разошлись.\n' +
        '  Выполните pnpm --filter @chatick/desktop sync-web перед сборкой.\n',
    )
  }
}

export default async function checkSignature(context) {
  checkPanelCopies()
  // Пакет для магазина подписывает Microsoft при публикации — своя подпись
  // там не нужна и даже мешает. Ругаться на неё было бы ложной тревогой.
  const forStore = (context.artifactPaths ?? []).some((f) => f.endsWith('.appx') || f.endsWith('.msix'))
  if (forStore) {
    console.log('\n— подпись —\n  пакет для Microsoft Store: подпишет магазин при публикации\n')
    return
  }

  const files = (context.artifactPaths ?? []).filter((f) => f.endsWith('.exe'))
  const unpacked = path.join(context.outDir ?? '', 'win-unpacked', 'Chatick.exe')
  if (existsSync(unpacked)) files.unshift(unpacked)
  if (!files.length) return

  let unsigned = 0
  console.log('\n— подпись —')
  for (const f of files) {
    const { status, subject, until } = signatureOf(f)
    if (status === 'skip') return
    const name = path.basename(f)
    if (status === 'Valid') {
      console.log(`  ✓ ${name}\n    ${subject}\n    действует до ${until}`)
    } else {
      unsigned++
      console.log(`  ✗ ${name} — ${status}`)
    }
  }

  if (unsigned) {
    // Не роняем сборку: собрать неподписанное для себя — законное желание,
    // а вот отдать людям, думая, что подписано, — нет. Поэтому говорим прямо.
    console.log(
      '\n  ВНИМАНИЕ: сборка не подписана. Windows покажет «неизвестный издатель»,\n' +
        '  а браузеры будут предупреждать при скачивании.\n' +
        '  Подпись включается сертификатом в CSC_LINK + CSC_KEY_PASSWORD\n' +
        '  (или win.certificateSubjectName, если ключ в хранилище Windows).\n',
    )
  }
}
