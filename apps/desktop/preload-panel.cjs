const { contextBridge, ipcRenderer } = require('electron')

// Мост для панели в трее. Панель ничего не умеет сама: она рисует состояние,
// которое ей присылают, и просит главный процесс что-то сделать.

contextBridge.exposeInMainWorld('panel', {
  onState: (fn) => {
    const handler = (_e, state) => fn(state)
    ipcRenderer.on('panel:state', handler)
    return () => ipcRenderer.off('panel:state', handler)
  },
  toggleTimer: () => ipcRenderer.send('panel:toggle-timer'),

  /**
   * Код подключения ассистента. Панель только передаёт введённое: проверяет
   * код и открывает туннель веб, у него есть сессия и права.
   */
  checkCode: (code) => ipcRenderer.send('panel:check-code', code),
  approveCode: (code, target) => ipcRenderer.send('panel:approve-code', { code, ...target }),
  revokeConnection: (id) => ipcRenderer.send('panel:revoke-connection', id),
  /** Вкладку «Доступ» открыли — самое время обновить список подключений. */
  refreshConnections: () => ipcRenderer.send('panel:refresh-connections'),
  onConnect: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('panel:connect', handler)
    return () => ipcRenderer.off('panel:connect', handler)
  },
  open: (link) => ipcRenderer.send('panel:open', link),
  openApp: () => ipcRenderer.send('window:show'),
  close: () => ipcRenderer.send('panel:close'),
})
