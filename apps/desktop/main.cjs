const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, shell, ipcMain, nativeImage } = require('electron')
const { autoUpdater } = require('electron-updater')
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
/** версия скачанного обновления — показываем в трее, что перезапуск не зря */
let updateReady = ''
/** проверить обновления вручную; задаётся в setupUpdates */
let checkUpdates = () => {}
/** Куда человек перетащил панель; null — держимся значка в трее. */
let panelPos = null

// Состояние, которое присылает веб. Главный процесс не ходит в API сам: он
// ничего не знает про токены и права, и знать не должен.
//
// Последнее известное состояние храним на диске и поднимаем при старте.
// Без этого панель после запуска трея открывалась пустой: надписи приходят
// только из окна, а пока оно не проснулось, видны английские запасные
// значения и пустая строка-приглашение. Данные тут не секретные — списки
// задач и проектов, тексты интерфейса; токенов и прав здесь нет.
let state = { authed: true, unread: 0, timer: null }

const statePath = () => path.join(app.getPath('userData'), 'panel-state.json')

function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    // Таймер и счётчик непрочитанного — вещи «сейчасные»: показывать вчерашние
    // значения хуже, чем не показывать никаких.
    state = { ...saved, timer: null, unread: 0 }
  } catch {
    // первого запуска ещё не было, или файл повреждён — это не беда
  }
}

let saveTimer = null
function persistState() {
  clearTimeout(saveTimer)
  // Состояние обновляется часто; пишем не чаще раза в секунду.
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(statePath(), JSON.stringify(state))
    } catch {
      // не смогли сохранить — панель просто будет пустой при следующем старте
    }
  }, 1000)
}

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

  // Веб смонтировал обработчики — можно отдавать накопленные команды.
  win.webContents.on('did-finish-load', flushPending)

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else if (LOAD_MODE === 'remote') {
    // Интерфейс грузится с сайта, значит обновляется сам — но только если мы
    // не отдадим человеку вчерашнюю копию из кеша. Ассеты именованы хешем и
    // кешируются вечно; index.html спрашиваем у сервера каждый раз.
    win.loadURL(APP_URL, { extraHeaders: ['pragma: no-cache', 'cache-control: no-cache', ''].join('\n') })
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
      label: tr('reload', 'Reload'),
      click: async () => {
        // Заодно спрашиваем сервер о новой версии: человек, нажавший
        // «Обновить», ждёт именно этого — а не только перезагрузки страницы.
        checkUpdates()
        // Полная перезагрузка с чисткой кеша: последняя линия обороны, если
        // страница всё-таки залипла на старой версии.
        await win?.webContents.session.clearCache()
        win?.webContents.reloadIgnoringCache()
        showWindow()
      },
    },
    ...(updateReady
      ? [
          {
            label: `${tr('updateReady', 'Restart to update')} (${updateReady})`,
            click: () => {
              quitting = true
              autoUpdater.quitAndInstall()
            },
          },
          { type: 'separator' },
        ]
      : []),
    {
      label: tr('notifySettings', 'Notification settings'),
      click: () => {
        showWindow()
        send('navigate', '/settings/notifications')
      },
    },
    { type: 'separator' },
    {
      label: tr('about', 'About'),
      click: () => {
        showWindow()
        send('open:about')
      },
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
  // Значок должен читаться на любой панели: на тёмной — белый, на светлой —
  // чёрный. Windows умеет обе темы, и угадывать тут нечего — система отвечает.
  const { nativeTheme } = require('electron')
  const light = !nativeTheme.shouldUseDarkColors
  const name = state.timer
    ? light ? 'tray-active-light.png' : 'tray-active.png'
    : light ? 'tray-light.png' : 'tray.png'

  const base = loadIcon(name)
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
  tray = new Tray(trayImage())

  // Тему панели меняют на ходу — значок должен переодеться, а не остаться
  // белым на белом.
  const { nativeTheme } = require('electron')
  nativeTheme.on('updated', () => tray?.setImage(trayImage()))
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

  // Состояние — сразу после загрузки. Панель создаётся по первому клику, и
  // send() до окончания загрузки уходит в пустоту: окно оставалось пустым до
  // следующего обновления от веба, а его можно ждать минуту.
  panel.webContents.on('did-finish-load', () => {
    if (panel && !panel.webContents.isLoading()) panel.webContents.send('panel:state', state)
    // И просим окно прислать свежее: на первом открытии state ещё пуст —
    // отсюда «открыл трей сразу после запуска, а там пусто; закрыл, открыл
    // снова — работает». Второй раз панель уже загружена, а state успел
    // наполниться.
    send('desktop:refresh', null)
  })

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
    if (!panel.webContents.isLoading()) panel.webContents.send('panel:state', state)
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
  if (!panel.webContents.isLoading()) panel.webContents.send('panel:state', state)
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

/**
 * Команда в веб-окно.
 *
 * Окно может быть закрыто, ещё грузиться или перезагружаться — тогда прямой
 * send() уходит в никуда, и действие человека (открыть уведомление, запустить
 * таймер) молча теряется. Копим такие команды и отдаём, когда окно готово.
 */
const pending = []

function send(channel, payload) {
  if (!win || win.webContents.isLoading()) {
    pending.push({ channel, payload })
    if (!win) createWindow()
    return
  }
  win.webContents.send(channel, payload)
}

/** Окно догрузилось — отдаём накопленное. */
function flushPending() {
  if (!win || !pending.length) return
  for (const { channel, payload } of pending.splice(0)) win.webContents.send(channel, payload)
}

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
      companies: Array.isArray(next?.companies) ? next.companies : [],
      connections: Array.isArray(next?.connections) ? next.connections : [],
      strings: next?.strings ?? state.strings,
    }
    refreshTray()
    refreshBadge()
    persistState()
    panel?.webContents.send('panel:state', state)
  })

  ipcMain.on('notify', (_e, payload) => {
  if (!Notification.isSupported()) {
    console.warn('[chatick] система не поддерживает уведомления')
    return
  }
  const n = new Notification({
    title: payload?.title || 'Chatick',
    body: payload?.body || '',
    icon: loadIcon('icon.png'),
    // Звук — общая настройка приложения, а не системы: человек решает один
    // раз, а не отдельно для окна и для трея.
    silent: Boolean(payload?.silent),
  })
  n.on('failed', (_ev, err) => console.warn('[chatick] уведомление не показано:', err))
  // Клик ведёт туда, где событие произошло: уведомление без перехода бесполезно.
  n.on('click', () => {
    showWindow()
    // Объект, а не строка: вместе со ссылкой уходит id, иначе уведомление
    // останется непрочитанным — по ссылке его не опознать, несколько разных
    // ведут в одно место.
    if (payload?.link) send('navigate', { link: payload.link, notificationId: payload.notificationId ?? null })
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
  ipcMain.on('panel:open', (_e, payload) => {
    panel?.hide()
    showWindow()
    // Строка — из старых вызовов (строка проектов), объект — из списка
    // уведомлений, где вместе со ссылкой едет id прочитанного.
    const link = typeof payload === 'string' ? payload : payload?.link
    if (link) send('navigate', { link, notificationId: typeof payload === 'string' ? null : payload?.notificationId })
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
  ipcMain.on('panel:task-timer', (_e, taskId) => send('task:timer', taskId))
  ipcMain.on('panel:task-status', (_e, payload) => send('task:status', payload))
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

/**
 * Обновление оболочки.
 *
 * Интерфейс грузится с сайта и обновляется сам при каждом запуске — здесь
 * речь только про саму программу: главный процесс, трей, уведомления. Их
 * иначе не обновить, кроме как переустановкой.
 *
 * Ставим тихо и применяем при выходе: прерывать работу ради перезапуска —
 * худшее, что может сделать программа, в которой люди переписываются.
 */
function setupUpdates() {
  // В разработке обновляться неоткуда и незачем
  if (isDev || !app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[desktop] обновление готово, поставится при выходе:', info?.version)
    updateReady = info?.version ?? ''
    refreshTray()
  })
  autoUpdater.on('error', (e) => {
    // Молча: недоступный сервер обновлений — не повод пугать человека
    console.warn('[desktop] проверка обновлений не удалась:', e?.message ?? e)
  })

  checkUpdates = () => autoUpdater.checkForUpdates().catch(() => {})
  checkUpdates()
  // Раз в час: приложение живёт в трее неделями, и шесть часов означали, что
  // о свежей версии человек узнаёт в лучшем случае к вечеру.
  setInterval(checkUpdates, 60 * 60 * 1000)
}

  app.whenReady().then(() => {
    // Windows связывает уведомления с приложением по AppUserModelID. Без него
    // система молча выбрасывает всплывашки: Notification.isSupported() врёт
    // «да», show() отрабатывает без ошибки, и на экране не появляется ничего.
    // Значение обязано совпадать с appId сборки, иначе Windows считает это
    // другим приложением.
    if (process.platform === 'win32') app.setAppUserModelId('com.chatick.app')
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    // До createTray: значок и подсказка рисуются из state, и с прошлой сессии
    // они уже верные — незачем показывать пустые, пока окно просыпается.
    restoreState()
    registerIpc()
    createWindow()
    createTray()
    registerShortcuts()
    setupUpdates()

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
