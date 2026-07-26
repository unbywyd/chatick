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

// Состояние, которое присылает веб. Главный процесс не ходит в API сам: он
// ничего не знает про токены и права, и знать не должен.
let state = { unread: 0, timer: null }

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

function trayTooltip() {
  const parts = ['Chatick']
  if (state.timer) parts.push(`⏱ ${state.timer.description || 'таймер идёт'}`)
  if (state.unread) parts.push(`${state.unread} непрочитанных`)
  return parts.join(' · ')
}

function buildTrayMenu() {
  const running = Boolean(state.timer)
  return Menu.buildFromTemplate([
    { label: 'Открыть Chatick', click: showWindow },
    { type: 'separator' },
    {
      // Таймер из трея — то, ради чего чаще всего лезут, не открывая окно.
      label: running
        ? `Остановить таймер${state.timer.description ? ` — ${state.timer.description}` : ''}`
        : 'Запустить таймер',
      click: () => {
        send('timer:toggle')
        showWindow()
      },
    },
    { type: 'separator' },
    {
      label: 'Запускать при входе в систему',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Выход',
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
  // иконка меняется, когда таймер идёт — видно, что учёт включён
  tray.setImage(loadIcon(state.timer ? 'tray-active.png' : 'tray.png'))
}

function createTray() {
  tray = new Tray(loadIcon('tray.png'))
  tray.on('click', showWindow)
  refreshTray()
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
  win.setOverlayIcon(badge && !badge.isEmpty() ? badge : null, n > 0 ? `${n} непрочитанных` : '')
}

// --- связь с вебом ------------------------------------------------------------

const send = (channel, payload) => win?.webContents.send(channel, payload)

/** IPC регистрируется после whenReady: раньше ipcMain ещё не существует. */
function registerIpc() {
  ipcMain.on('state:update', (_e, next) => {
  state = { unread: Number(next?.unread) || 0, timer: next?.timer ?? null }
  refreshTray()
  refreshBadge()
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

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// Окно живёт в трее — закрытие последнего окна не гасит приложение.
app.on('window-all-closed', () => {})
