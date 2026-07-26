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

  /**
   * Открыть ссылку в системном браузере. Нужно для входа: Google не показывает
   * свой экран согласия внутри встроенного окна.
   */
  openExternal: (url) => ipcRenderer.send('open-external', url),

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
  /** Ответ панели на её же запрос про код подключения. */
  connectResult: (payload) => ipcRenderer.send('connect:result', payload),

  onConnectCheck: (fn) => {
    const handler = (_e, code) => fn(code)
    ipcRenderer.on('connect:check', handler)
    return () => ipcRenderer.off('connect:check', handler)
  },
  onConnectApprove: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('connect:approve', handler)
    return () => ipcRenderer.off('connect:approve', handler)
  },
  onConnectRefresh: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('connect:refresh', handler)
    return () => ipcRenderer.off('connect:refresh', handler)
  },
  onConnectRevoke: (fn) => {
    const handler = (_e, id) => fn(id)
    ipcRenderer.on('connect:revoke', handler)
    return () => ipcRenderer.off('connect:revoke', handler)
  },
  onNavigate: (fn) => {
    const handler = (_e, link) => fn(link)
    ipcRenderer.on('navigate', handler)
    return () => ipcRenderer.off('navigate', handler)
  },
})
