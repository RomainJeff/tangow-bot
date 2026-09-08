const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rakazoSetup", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  test: (url, access) => ipcRenderer.invoke("desktop.setup.test", url, access),
  save: (setup, access) => ipcRenderer.invoke("desktop.setup.save", setup, access),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
  openLink: (link) => ipcRenderer.invoke("desktop.setup.openLink", link),
  stack: {
    state: () => ipcRenderer.invoke("desktop.setup.stack.state"),
    start: () => ipcRenderer.invoke("desktop.setup.stack.start"),
    onChange: (listener) => {
      ipcRenderer.on("desktop.setup.stack.changed", (_event, state) => listener(state));
    },
  },
});
