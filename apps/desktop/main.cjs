const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, shell, ipcMain, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Десктоп Chatick (SPEC §8.33).
//
// Интерфейс грузится с сайта, а не из вшитых файлов: у проекта высокий темп
// правок, и вшитая сборка означала бы переустановку у всех ради каждой мелочи.
// Офлайна это не отнимает — Chatick и так бесполезен без сети, зато вместо
// белого листа показываем понятный экран «нет соединения».
// Чтобы вернуться к вшитым файлам, достаточно поменять LOAD_MODE.

const isDev = process.argv.includes('--dev')
const LOAD_MODE = 'remote' // 'remote' | 'bundled'
const APP_URL = process.env.CHATICK_URL || 'https://app.chatick.com'


let win = null
let tray = null
let quitting = false
/** Куда человек перетащил панель; null — держимся значка в трее. */
let panelPos = null

// Состояние, которое присылает веб. Главный процесс не ходит в API сам: он
// ничего не знает про токены и права, и знать не должен.
let state = { authed: true, unread: 0, timer: null }

const iconPath = (name) => path.join(__dirname, 'assets', name)

function loadIcon(name) {
  const p = iconPath(name)
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
}

// --- окно ---------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false, // показываем по ready-to-show, иначе мелькает белый прямоугольник
    backgroundColor: '#0a0a0a',
    icon: loadIcon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  // Меню File/Edit/View/Help к Chatick отношения не имеет и занимает строку.
  // На macOS меню живёт в системной панели: без него отвалятся Cmd+C и Cmd+Q,
  // поэтому убираем только там, где оно рисуется внутри окна.
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)

  win.once('ready-to-show', () => win.show())

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else if (LOAD_MODE === 'remote') {
    win.loadURL(APP_URL)
  } else {
    win.loadFile(path.join(__dirname, 'web', 'index.html'))
  }

  // Сеть отвалилась — внятная страница с кнопкой, а не пустое окно.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = отменённая навигация, не ошибка
    console.error('[desktop] load failed:', code, desc, url)
    win.loadFile(path.join(__dirname, 'offline.html'))
  })

  // Внешние ссылки — в системный браузер: приложение не должно превращаться
  // в браузер общего назначения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? 'http://localhost:5173' : APP_URL
    if (!url.startsWith(allowed) && !url.startsWith('file://')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // Закрытие сворачивает в трей: таймер продолжает идти, уведомления приходят.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    if (process.platform === 'darwin') app.dock?.hide()
  })
}

function showWindow() {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (process.platform === 'darwin') app.dock?.show()
  win.focus()
}

// --- трей ---------------------------------------------------------------------

/** Подпись из присланных вебом переводов; запасное значение — пока их нет. */
const tr = (key, fallback) => state.strings?.[key] || fallback

/**
 * Сколько идёт таймер — для подсказки над значком в трее.
 * Своя копия, а не общая с панелью: панель живёт в отдельном процессе и
 * ничего из главного не импортирует.
 */
function elapsedText(timer) {
  const started = timer?.startedAt ? new Date(timer.startedAt).getTime() : NaN
  if (Number.isNaN(started)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - started) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} ${tr('minShort', 'min')}`
}

function trayTooltip() {
  const parts = ['Chatick']
  if (state.timer) parts.push(`⏱ ${elapsedText(state.timer)} · ${state.timer.description || tr('noTask', 'no task')}`)
  if (state.unread) parts.push(`${state.unread} ${tr('unreadOne', 'unread')}`)
  return parts.join(' · ')
}

function buildTrayMenu() {
  // Всё содержательное живёт в панели, включая таймер; правой кнопкой — только
  // то, чему в панели места нет: автозапуск и выход.
  return Menu.buildFromTemplate([
    {
      label: state.authed ? tr('openApp', 'Open Chatick') : tr('signIn', 'Sign in'),
      click: showWindow,
    },
    { type: 'separator' },
    {
      label: tr('launchAtLogin', 'Launch at login'),
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: tr('quit', 'Quit'),
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function refreshTray() {
  if (!tray) return
  tray.setToolTip(trayTooltip())
  tray.setContextMenu(buildTrayMenu())
  tray.setImage(trayImage())
}

/**
 * Значок трея: точка непрочитанных поверх иконки. Без неё о новом можно узнать
 * только наведя курсор, а трей для того и нужен, чтобы видеть краем глаза.
 * Цвет меняется, когда идёт таймер — учёт виден отдельно от уведомлений.
 */
function trayImage() {
  const base = loadIcon(state.timer ? 'tray-active.png' : 'tray.png')
  if (!state.unread || base.isEmpty()) return base
  return withDot(base)
}

/**
 * Точка непрочитанных поверх значка.
 *
 * Рисуем пиксели руками: nativeImage не умеет ни SVG (createFromBuffer ждёт
 * PNG/JPEG), ни рисование поверх, а заводить графическую библиотеку ради
 * кружка в углу несоразмерно.
 */
function withDot(base) {
  const size = { width: 32, height: 32 }
  const px = Buffer.from(base.resize(size).toBitmap())
  if (px.length < size.width * size.height * 4) return base // формат не тот — лучше без точки, чем каша

  // Круг в правом верхнем углу. BGRA, как отдаёт toBitmap.
  const cx = 24
  const cy = 8
  const r = 7
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue
      const d = Math.hypot(x - cx, y - cy)
      if (d > r) continue
      const i = (y * size.width + x) * 4
      // Тёмная окантовка отделяет точку от светлого значка.
      const edge = d > r - 1.6
      px[i] = edge ? 0x0f : 0x4d // B
      px[i + 1] = edge ? 0x0f : 0x48 // G
      px[i + 2] = edge ? 0x0f : 0xe5 // R
      px[i + 3] = 0xff
    }
  }
  return nativeImage.createFromBitmap(px, size)
}

function createTray() {
  tray = new Tray(loadIcon('tray.png'))
  // Левый клик — панель (то, ради чего в трей и лезут), правый — короткое меню.
  tray.on('click', togglePanel)
  refreshTray()
}

// --- панель в трее ------------------------------------------------------------
// Контекстное меню упирается в потолок: только текст, ни аватарок, ни живого
// таймера, ни прогресса. Панель — маленькое окно со своей вёрсткой, которое
// открывается по клику на значок и прячется, когда теряет фокус.

let panel = null

function createPanel() {
  panel = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true, // панель — не окно приложения, ей нечего делать в панели задач
    alwaysOnTop: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  panel.loadFile(path.join(__dirname, 'panel.html'))

  // Перетащили — запоминаем. Событие приходит и при нашем setPosition,
  // поэтому пишем только когда панель видима и двигал её человек.
  panel.on('moved', () => {
    if (!panel?.isVisible()) return
    const [x, y] = panel.getPosition()
    panelPos = { x, y }
  })

  // Панель закрывается только руками — кнопкой «Закрыть» или значком в трее.
  // Закрытие по клику мимо (как у меню в трее) здесь мешает: в панель ходят
  // с кодом или задачей из другого окна, и она захлопывалась на полпути.
}

/** Показать панель рядом со значком, не вылезая за края экрана. */
function togglePanel() {
  if (!panel) createPanel()
  if (panel.isVisible()) return panel.hide()

  // Панель сдвинули руками — уважаем это: возвращать её к значку значит
  // отменять решение человека при каждом открытии.
  if (panelPos) {
    panel.setPosition(panelPos.x, panelPos.y)
    panel.webContents.send('panel:state', state)
    panel.show()
    panel.focus()
    return
  }

  const { screen } = require('electron')
  const iconBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: iconBounds.x, y: iconBounds.y })
  const area = display.workArea
  const [w, h] = panel.getSize()

  // Значок может быть внизу (Windows), сверху (macOS) или сбоку — считаем от него.
  const x = Math.round(Math.min(Math.max(iconBounds.x + iconBounds.width / 2 - w / 2, area.x + 8), area.x + area.width - w - 8))
  const below = iconBounds.y < area.y + area.height / 2
  const y = below ? iconBounds.y + iconBounds.height + 6 : iconBounds.y - h - 6

  panel.setPosition(x, Math.round(Math.max(area.y + 8, y)))
  panel.webContents.send('panel:state', state)
  panel.show()
  panel.focus()
}

// --- бейдж --------------------------------------------------------------------

function refreshBadge() {
  const n = state.unread
  if (process.platform === 'darwin') {
    app.dock?.setBadge(n > 0 ? String(n) : '')
    return
  }
  if (!win) return
  // Windows: наложение на кнопку в панели задач
  const badge = n > 0 ? loadIcon('badge.png') : null
  win.setOverlayIcon(badge && !badge.isEmpty() ? badge : null, n > 0 ? `${n} ${tr('unreadOne', 'unread')}` : '')
}

// --- связь с вебом ------------------------------------------------------------

const send = (channel, payload) => win?.webContents.send(channel, payload)

/** IPC регистрируется после whenReady: раньше ipcMain ещё не существует. */
function registerIpc() {
  ipcMain.on('state:update', (_e, next) => {
    state = {
      authed: next?.authed !== false,
      unread: Number(next?.unread) || 0,
      timer: next?.timer ?? null,
      notifications: Array.isArray(next?.notifications) ? next.notifications : [],
      tasks: Array.isArray(next?.tasks) ? next.tasks : [],
      projects: Array.isArray(next?.projects) ? next.projects : [],
      project: next?.project ?? null,
      company: next?.company ?? null,
      connections: Array.isArray(next?.connections) ? next.connections : [],
      strings: next?.strings ?? state.strings,
    }
    refreshTray()
    refreshBadge()
    panel?.webContents.send('panel:state', state)
  })

  ipcMain.on('notify', (_e, payload) => {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: payload?.title || 'Chatick',
    body: payload?.body || '',
    icon: loadIcon('icon.png'),
  })
  // Клик ведёт туда, где событие произошло: уведомление без перехода бесполезно.
  n.on('click', () => {
    showWindow()
    if (payload?.link) send('navigate', payload.link)
  })
  n.show()
  })

  ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  }))

  ipcMain.on('window:show', showWindow)

  // Вход открывается в системном браузере: Google не показывает свой экран
  // согласия внутри встроенного окна. Пускаем только http(s) — ipc открыт
  // вебу, и передать сюда file:// или произвольную схему не должно быть
  // способом что-то запустить.
  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // Действия из панели: она сама ничего не умеет, только просит главный процесс.
  // Панель остаётся открытой: человек нажал «старт» и должен увидеть, что
  // таймер действительно пошёл, а не гадать по исчезнувшему окну.
  ipcMain.on('panel:toggle-timer', () => send('timer:toggle'))
  ipcMain.on('panel:open', (_e, link) => {
    panel?.hide()
    showWindow()
    if (link) send('navigate', link)
  })
  ipcMain.on('panel:close', () => panel?.hide())

  // Подключение ассистента: панель передаёт код, веб проверяет и открывает
  // туннель, ответ возвращается в панель. Главный процесс здесь только
  // почтальон — он не знает ни про сессии, ни про права.
  ipcMain.on('panel:check-code', (_e, code) => send('connect:check', code))
  ipcMain.on('panel:approve-code', (_e, payload) => send('connect:approve', payload))
  ipcMain.on('panel:refresh-connections', () => send('connect:refresh'))
  // Выбор проекта из панели: окно не показываем — человек остался в панели
  // намеренно, а веб просто переходит на нужный проект в фоне.
  ipcMain.on('panel:set-project', (_e, id) => send('project:set', id))
  ipcMain.on('panel:revoke-connection', (_e, id) => send('connect:revoke', id))
  ipcMain.on('connect:result', (_e, payload) => panel?.webContents.send('panel:connect', payload))
}

// --- горячие клавиши ----------------------------------------------------------

function registerShortcuts() {
  // Старт/стоп таймера из любого приложения — ради этого десктоп и нужен,
  // иначе проще держать вкладку в браузере.
  const toggled = globalShortcut.register('CommandOrControl+Shift+T', () => send('timer:toggle'))
  const shown = globalShortcut.register('CommandOrControl+Shift+C', showWindow)
  if (!toggled || !shown) console.warn('[desktop] часть горячих клавиш занята другим приложением')
}

// --- запуск -------------------------------------------------------------------

// Второй экземпляр не поднимаем: два окна с одним аккаунтом путают уведомления
// и таймеры.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    registerIpc()
    createWindow()
    createTray()
    registerShortcuts()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })
}

// Ошибка в отрисовке трея не должна убивать приложение системным диалогом:
// таймер идёт, уведомления приходят — терять это из-за подписи над значком
// несоразмерно. Пишем в консоль и живём дальше.
process.on('uncaughtException', (err) => console.error('[desktop] uncaught:', err))
process.on('unhandledRejection', (err) => console.error('[desktop] unhandled rejection:', err))

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Окно живёт в трее — закрытие последнего окна не гасит приложение.
app.on('window-all-closed', () => {})
