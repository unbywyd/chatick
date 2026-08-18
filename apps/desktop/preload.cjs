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
    // Панель присылает проект, в который стартовать; null — «стоп».
    const handler = (_e, projectId) => fn(projectId)
    ipcRenderer.on('timer:toggle', handler)
    return () => ipcRenderer.off('timer:toggle', handler)
  },
  /** Ответ панели на её же запрос про код подключения. */
  connectResult: (payload) => ipcRenderer.send('connect:result', payload),

  /**
   * Ассистент просит доступ через установленное приложение — без кода.
   * Веб показывает окно выбора (проект или компания) и отвечает токеном
   * либо null, если человек отказался.
   */
  onGrantRequest: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('connect:grant-request', handler)
    return () => ipcRenderer.off('connect:grant-request', handler)
  },
  grantResult: (payload) => ipcRenderer.send('connect:grant-result', payload),

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
  onTaskTimer: (fn) => {
    const handler = (_e, taskId) => fn(taskId)
    ipcRenderer.on('task:timer', handler)
    return () => ipcRenderer.off('task:timer', handler)
  },
  onTimerElapsed: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('timer:elapsed', handler)
    return () => ipcRenderer.off('timer:elapsed', handler)
  },
  onTaskStatus: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('task:status', handler)
    return () => ipcRenderer.off('task:status', handler)
  },
  onOpenAbout: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('open:about', handler)
    return () => ipcRenderer.off('open:about', handler)
  },
  onSetProject: (fn) => {
    const handler = (_e, id) => fn(id)
    ipcRenderer.on('project:set', handler)
    return () => ipcRenderer.off('project:set', handler)
  },
  // Панель открылась и просит окно прислать состояние заново: на первом
  // открытии главный процесс ещё пуст, и панель рисуется без надписей.
  onStateRefresh: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('desktop:refresh', handler)
    return () => ipcRenderer.off('desktop:refresh', handler)
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
