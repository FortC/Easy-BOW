// 覆盖层沙盒页面的唯一 IPC 通道：顶部状态条「暂停/继续」按钮 → 主进程 AgentRunner
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('easybowOvl', {
  pause: () => ipcRenderer.send('overlay:pause'),
  resume: () => ipcRenderer.send('overlay:resume')
})
