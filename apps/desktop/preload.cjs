const { contextBridge } = require('electron')

// Минимальный мост: веб-приложение может определить, что оно внутри десктопа.
contextBridge.exposeInMainWorld('chatickDesktop', {
  version: process.versions.electron,
})
