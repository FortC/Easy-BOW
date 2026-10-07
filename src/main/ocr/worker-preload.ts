import { contextBridge, ipcRenderer } from 'electron'

// OCR 隐藏窗口的 IPC 桥（最小化暴露面）
contextBridge.exposeInMainWorld('__ocrBridge', {
  ready: () => ipcRenderer.invoke('ocr:ready'),
  onRun: (cb: (msg: any) => void) => {
    ipcRenderer.on('ocr:run', (_e, msg) => cb(msg))
  },
  result: (payload: any) => ipcRenderer.invoke('ocr:result', payload)
})
