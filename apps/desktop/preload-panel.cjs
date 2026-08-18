const { contextBridge, ipcRenderer } = require('electron')

// Мост для панели в трее. Панель ничего не умеет сама: она рисует состояние,
// которое ей присылают, и просит главный процесс что-то сделать.

contextBridge.exposeInMainWorld('panel', {
  onState: (fn) => {
    const handler = (_e, state) => fn(state)
    ipcRenderer.on('panel:state', handler)
    return () => ipcRenderer.off('panel:state', handler)
  },
  toggleTimer: (projectId) => ipcRenderer.send('panel:toggle-timer', projectId ?? null),

  /**
   * Код подключения ассистента. Панель только передаёт введённое: проверяет
   * код и открывает туннель веб, у него есть сессия и права.
   */
  checkCode: (code) => ipcRenderer.send('panel:check-code', code),
  approveCode: (code, target) => ipcRenderer.send('panel:approve-code', { code, ...target }),
  revokeConnection: (id) => ipcRenderer.send('panel:revoke-connection', id),
  /** Вкладку «Доступ» открыли — самое время обновить список подключений. */
  refreshConnections: () => ipcRenderer.send('panel:refresh-connections'),
  /** Сделать проект активным, не открывая окно приложения. */
  setProject: (id) => ipcRenderer.send('panel:set-project', id),
  /** Запустить/остановить таймер на конкретной задаче. */
  taskTimer: (taskId) => ipcRenderer.send('panel:task-timer', taskId),
  // Правка натикавшего: СЕКУНДЫ, а не новая дата начала — считает веб, у него
  // и права, и обработка ошибок. Секунды, а не минуты: округление делало
  // правку одних секунд бессмысленной, «10:10» и «10:20» давали одно и то же.
  setTimerElapsed: (id, seconds) => ipcRenderer.send('panel:timer-elapsed', { id, seconds }),
  /** Сменить статус своей задачи, не открывая приложение. */
  taskStatus: (taskId, status) => ipcRenderer.send('panel:task-status', { taskId, status }),
  onConnect: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('panel:connect', handler)
    return () => ipcRenderer.off('panel:connect', handler)
  },
  open: (link, notificationId) => ipcRenderer.send('panel:open', { link, notificationId }),
  // Переход в проект из заголовка группы «Мне»: там показаны все его
  // уведомления, и человек, ушедший по этой дорожке, увидел их все.
  openProject: (link, projectId) => ipcRenderer.send('panel:open', { link, projectId }),
  openApp: () => ipcRenderer.send('window:show'),
  close: () => ipcRenderer.send('panel:close'),
})
