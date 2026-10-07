import { contextBridge, ipcRenderer } from 'electron'
import type { CCSwitchProviderInfo, EasybowApi, KBEntry, MainEvent } from '@shared/types'

const api: EasybowApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  listCCSwitchProviders: () => ipcRenderer.invoke('ccswitch:list'),
  getKB: () => ipcRenderer.invoke('kb:get'),
  setKB: (entries: KBEntry[]) => ipcRenderer.invoke('kb:set', entries),
  testConnection: () => ipcRenderer.invoke('llm:test'),
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  switchTab: (id) => ipcRenderer.invoke('tab:switch', id),
  navigate: (url) => ipcRenderer.invoke('tab:navigate', url),
  goBack: () => ipcRenderer.invoke('tab:back'),
  goForward: () => ipcRenderer.invoke('tab:forward'),
  reload: () => ipcRenderer.invoke('tab:reload'),
  listHistory: (query) => ipcRenderer.invoke('history:list', query),
  removeHistory: (url) => ipcRenderer.invoke('history:remove', url),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  startTask: (task) => ipcRenderer.invoke('agent:start', task),
  pauseTask: () => ipcRenderer.invoke('agent:pause'),
  resumeTask: () => ipcRenderer.invoke('agent:resume'),
  stopTask: () => ipcRenderer.invoke('agent:stop'),
  sendGuidance: (text, imageDataUrl) => ipcRenderer.invoke('agent:guidance', text, imageDataUrl),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:readImage'),
  fastllmStatus: () => ipcRenderer.invoke('fastllm:status'),
  fastllmInit: () => ipcRenderer.invoke('fastllm:init'),
  getSchedules: () => ipcRenderer.invoke('schedules:get'),
  saveSchedule: (s) => ipcRenderer.invoke('schedules:save', s),
  deleteSchedule: (id) => ipcRenderer.invoke('schedules:delete', id),
  cancelScheduledRun: (id) => ipcRenderer.invoke('schedules:cancel', id),
  appVersion: () => ipcRenderer.invoke('app:version'),
  getAgentStatus: () => ipcRenderer.invoke('agent:status'),
  debugExtract: () => ipcRenderer.invoke('debug:extract'),
  setBrowserRect: (rect) => ipcRenderer.send('layout:browser-rect', rect),
  setBrowserHidden: (hidden) => ipcRenderer.send('layout:browser-hidden', hidden),
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: MainEvent) => cb(ev)
    ipcRenderer.on('main-event', listener)
    return () => ipcRenderer.removeListener('main-event', listener)
  }
}

contextBridge.exposeInMainWorld('easybow', api)
