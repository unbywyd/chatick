const { contextBridge, ipcRenderer } = require('electron')

// Мост в веб-приложение (SPEC §8.33). Узкий намеренно: наружу отдаём только то,
// что нужно интерфейсу, — никакого доступа к файловой системе или процессу.

contextBridge.exposeInMainWorld('chatickDesktop', {
  version: process.versions.electron,
  platform: process.platform,

  /** Сколько непрочитанных и что за таймер идёт — для трея и бейджа. */
  setState: (state) => ipcRenderer.send('state:update', state),

  /** Системное уведомление. link — куда вести по клику. */
  notify: (payload) => ipcRenderer.send('notify', payload),

  /** Поднять окно (например, после действия из трея). */
  show: () => ipcRenderer.send('window:show'),

  info: () => ipcRenderer.invoke('app:info'),

  /**
   * Подписки на команды из главного процесса. Возвращают функцию отписки —
   * без неё при пересборке накапливаются слушатели и одно нажатие срабатывает
   * несколько раз.
   */
  onToggleTimer: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('timer:toggle', handler)
    return () => ipcRenderer.off('timer:toggle', handler)
  },
  onNavigate: (fn) => {
    const handler = (_e, link) => fn(link)
    ipcRenderer.on('navigate', handler)
    return () => ipcRenderer.off('navigate', handler)
  },
})
