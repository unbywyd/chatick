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
  open: (link) => ipcRenderer.send('panel:open', link),
  openApp: () => ipcRenderer.send('window:show'),
  close: () => ipcRenderer.send('panel:close'),
})
