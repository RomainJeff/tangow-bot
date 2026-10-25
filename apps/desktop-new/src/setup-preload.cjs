const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daxSetup", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  test: (url, access) => ipcRenderer.invoke("desktop.setup.test", url, access),
  save: (setup, access) => ipcRenderer.invoke("desktop.setup.save", setup, access),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
});
