import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { join } from 'path'
import { TabManager } from './tabs'
import { Executor } from './executor'
import { AgentRunner } from './agent/runner'
import { Overlay } from './overlay'
import { getSettings, saveSettings } from './settings'
import { getKB, setKB } from './knowledge'
import { createProvider, isVisionUnsupportedError, TINY_TEST_IMAGE } from './agent/llm'
import { listCCSwitchProviders } from './ccswitch'
import { recordHistory, touchHistoryTitle, listHistory, removeHistory, clearHistory } from './history'
import { formatCandidates } from './extractor'
import { runSelftest } from './selftest'
import { runFastllmTest, isFastllmTest } from './fastllm-test'
import { tryInitOcr, ocrEnhanceExtract, ocrPageText } from './ocr'
import { FastLlm } from './fastllm'
import { Scheduler } from './scheduler'
import type { KBEntry, MainEvent, Schedule, Settings } from '@shared/types'

// 禁用站点 webview 的默认菜单干扰
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// 关于面板（Windows 经菜单/代码触发；联系方式与发布人档案一致）
app.setAboutPanelOptions({
  applicationName: 'EasyBow',
  applicationVersion: app.getVersion(),
  authors: ['clb'],
  website: 'mailto:lamthebest@foxmail.com',
  copyright: 'MIT License · AI 浏览器 · 联系：lamthebest@foxmail.com'
})

let win: BrowserWindow | null = null
let tabManager: TabManager
let executor: Executor
let runner: AgentRunner
let fastllm: FastLlm
let scheduler: Scheduler

/** 直接发送已构造的事件（AgentRunner 的 broadcast 回调走这里，避免二次包裹导致渲染层拿到的 status 缺字段） */
function sendEvent(ev: MainEvent): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('main-event', ev)
}

/** 统一事件广播：主进程 → 渲染进程（payload 为纯数据，不是事件对象） */
function broadcast(channel: string, payload: any): void {
  let ev: MainEvent
  switch (channel) {
    case 'tabs':
      ev = { channel: 'tabs', tabs: payload.tabs, activeTabId: payload.activeTabId }
      break
    case 'agent-status':
      ev = { channel: 'agent-status', status: payload }
      break
    case 'step':
      ev = { channel: 'step', step: payload }
      break
    case 'toast':
      ev = { channel: 'toast', message: payload.message, kind: payload.kind }
      break
    case 'ocr-status':
      ev = payload
      break
    default:
      return
  }
  sendEvent(ev)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  win.on('resize', () => tabManager?.onWindowResized())
  win.on('closed', () => {
    win = null
  })

  // —— UI 渲染器自愈：界面卡死/崩溃时自动重建（页签与页面在主进程，状态不丢） ——
  // 否则一次渲染器卡死会让窗口永远冻结在最后一帧，点什么都没反应
  let lastUiRecover = 0
  let uiRecoverTimer: NodeJS.Timeout | null = null
  /** 只负责杀（forceCrash 会触发 render-process-gone，由那里统一拉起，避免杀/载竞跑） */
  const killUi = (reason: string) => {
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    if (now - lastUiRecover < 15000) return // 防崩溃循环
    lastUiRecover = now
    console.error(`[easybow] UI 渲染器异常（${reason}），自动重建界面`)
    try {
      win.webContents.forcefullyCrashRenderer()
    } catch {}
  }
  win.webContents.on('unresponsive', () => {
    console.warn('[easybow] UI 渲染器无响应，6 秒后复查')
    if (uiRecoverTimer) clearTimeout(uiRecoverTimer)
    uiRecoverTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return
      Promise.race([
        win.webContents.executeJavaScript('1', true).catch(() => 'eval-error'),
        new Promise((r) => setTimeout(() => r('timeout'), 3000))
      ]).then((probe) => {
        if (probe === 'timeout' || probe === 'eval-error') killUi('持续无响应')
      })
    }, 6000)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.error(`[easybow] UI 渲染进程退出（${details.reason}），自动重载界面`)
    try {
      win?.webContents.reload()
    } catch {}
  })

  // 心跳看门狗：主进程侧每 8s 探测一次 UI 渲染器，连续 2 次无应答即重建。
  // 覆盖 busy-loop 与阻塞两类卡死（unresponsive 事件在部分场景不会触发）
  let hbMisses = 0
  const hbTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    let loading = false
    try {
      loading = win.webContents.isLoadingMainFrame()
    } catch {}
    if (loading) return // 加载期不作数
    Promise.race([
      win.webContents.executeJavaScript('1', true).then(
        () => true,
        () => true // 抛错（如渲染器刚重建）走 render-process-gone 路径，不算 miss
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000))
    ]).then((alive) => {
      if (alive) {
        hbMisses = 0
        return
      }
      hbMisses++
      console.warn(`[easybow] UI 心跳无应答（${hbMisses}/2）`)
      if (hbMisses >= 2) {
        hbMisses = 0
        killUi('心跳看门狗')
      }
    })
  }, 8000)
  // 窗口销毁时释放探针：否则 macOS activate 等路径反复 createWindow 会累积多份看门狗，
  // 各自独立计数的防崩溃冷却会被集体绕过
  win.on('closed', () => clearInterval(hbTimer))
  // 自愈后重新上报浏览器区域（新渲染器启动时也会自行上报，这里兜底）
  win.webContents.on('did-finish-load', () => tabManager?.onWindowResized())

  tabManager = new TabManager(win, broadcast)
  // 浏览历史：导航即记录，标题更新回填
  tabManager.onHistory = (url, title) => recordHistory(url, title)
  tabManager.onTitle = (url, title) => touchHistoryTitle(url, title)
  executor = new Executor(tabManager)
  executor.setMaxElementsProvider(() => getSettings().maxElements)
  tabManager.onTabClosed = (id) => executor.dropSnapshots(id)
  runner = new AgentRunner(tabManager, executor, sendEvent)
  // 本地快速决策模型（混合模式）：ready 前不参与决策，任务零影响
  fastllm = new FastLlm(sendEvent)
  runner.fastllm = fastllm
  // 定时任务：到点自动执行（AI 空闲时）；倒计时/取消经事件推送
  scheduler = new Scheduler(
    sendEvent,
    (task) => runner.startTask(task),
    () => {
      const st = runner.getStatus().state
      return st === 'idle' || st === 'done' || st === 'error' || st === 'stopped'
    }
  )
  scheduler.start()
  const overlay = new Overlay(win)
  executor.overlay = overlay
  tabManager.onLayout = (rect, hidden) => overlay.refit(rect, hidden)

  // OCR 初始化（异步，模型缺失时优雅降级）
  tryInitOcr()
    .then((status) => {
      broadcast('ocr-status', { channel: 'ocr-status', enabled: status.enabled, reason: status.reason })
      if (status.enabled) {
        runner.ocrEnhancer = (res, png) => ocrEnhanceExtract(tabManager, res, png)
        executor.ocrPageFallback = () => ocrPageText(tabManager)
      }
    })
    .catch(() => {})

  const s = getSettings()
  tabManager.newTab(s.homepage || 'https://www.baidu.com')

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const ok = (fn: (...args: any[]) => any) => (_e: any, ...args: any[]) =>
    Promise.resolve(fn(...args)).catch((err) => {
      throw new Error(err?.message || String(err))
    })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, s: Settings) => saveSettings(s))
  ipcMain.handle('kb:get', () => getKB())
  ipcMain.handle('kb:set', (_e, entries: KBEntry[]) => setKB(entries))
  // 读取系统剪贴板图片（人工介入「附截图」）：走主进程 Electron clipboard（W3C 风格新 API），
  // 返回 dataURL 或 null；渲染进程 navigator.clipboard.read() 因无 clipboard-read 权限必然失败
  ipcMain.handle('clipboard:readImage', async () => {
    try {
      const items = await clipboard.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = (await item.getType(type)) as Blob
        const buf = Buffer.from(await blob.arrayBuffer())
        if (!buf.length) continue
        const mime = type.split(';')[0].toLowerCase()
        return `data:${mime};base64,${buf.toString('base64')}`
      }
      return null
    } catch {
      return null
    }
  })
  ipcMain.handle('llm:test', async () => {
    const s = getSettings()
    const provider = createProvider(s)
    // 视觉模式开启：附带 1x1 测试图探测模型是否接受图片输入
    if (s.vision) {
      try {
        const r = await provider.chat('你是连接测试助手。只输出两个字：正常', [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ping（消息附带一张 1x1 测试图片，用于验证多模态输入）' },
              { type: 'image', dataUrl: TINY_TEST_IMAGE }
            ]
          }
        ])
        return { ok: true, message: `连接成功，支持视觉输入 ✅（模型回复: ${r.text.slice(0, 30)}）`, usage: r.usage }
      } catch (e: any) {
        if (isVisionUnsupportedError(e)) {
          // 纯文本再测一次，确认连接本身可用（运行时视觉模式会自动降级）
          const r2 = await provider.chat('你是连接测试助手。只输出两个字：正常', [
            { role: 'user', content: 'ping' }
          ])
          return {
            ok: true,
            message: `连接成功，但模型不接受图片输入 ⚠️ 运行时视觉模式将自动降级为元素列表（纯文本回复: ${r2.text.slice(0, 20)}）`,
            usage: r2.usage
          }
        }
        throw e
      }
    }
    const r = await provider.chat('你是连接测试助手。只输出两个字：正常', [
      { role: 'user', content: 'ping' }
    ])
    return { ok: true, message: `连接成功，模型回复: ${r.text.slice(0, 50)}`, usage: r.usage }
  })
  // 本地快速决策模型（混合模式）；bundled=模型已内置安装包（免下载）
  ipcMain.handle('fastllm:status', () => ({ ...fastllm.status, bundled: !!FastLlm.bundledModelDir() }))
  ipcMain.handle('fastllm:init', () => fastllm.init())
  // 定时任务
  ipcMain.handle('schedules:get', () => scheduler.list())
  ipcMain.handle('schedules:save', ok((s: Parameters<Scheduler['save']>[0]) => scheduler.save(s)))
  ipcMain.handle('schedules:delete', ok((id: number) => scheduler.remove(id)))
  ipcMain.handle('schedules:cancel', ok((id: number) => scheduler.cancelRun(id)))
  ipcMain.handle('app:version', () => app.getVersion())
  // 从本机 cc-switch 一键导入供应商配置
  ipcMain.handle('ccswitch:list', ok(() => listCCSwitchProviders()))

  ipcMain.handle('tab:new', ok((url?: string) => tabManager.newTab(url)))
  ipcMain.handle('tab:close', ok((id: number) => tabManager.closeTab(id)))
  ipcMain.handle('tab:switch', ok((id: number) => tabManager.switchTab(id)))
  ipcMain.handle('tab:navigate', ok((url: string) => tabManager.navigate(url)))
  ipcMain.handle('tab:back', () => tabManager.goBack())
  ipcMain.handle('tab:forward', () => tabManager.goForward())
  ipcMain.handle('tab:reload', () => tabManager.reload())

  // 浏览历史
  ipcMain.handle('history:list', ok((query?: string) => listHistory(query)))
  ipcMain.handle('history:remove', ok((url: string) => removeHistory(url)))
  ipcMain.handle('history:clear', () => clearHistory())

  ipcMain.handle('agent:start', ok((task: string) => runner.startTask(task)))
  ipcMain.handle('agent:pause', () => runner.pauseTask())
  ipcMain.handle('agent:resume', () => runner.resumeTask())
  ipcMain.handle('agent:stop', () => runner.stopTask())
  ipcMain.handle('agent:status', () => runner.getStatus())
  ipcMain.handle('agent:guidance', ok((text: string, image?: string) => runner.sendGuidance(text, image)))

  // 覆盖层顶部状态条的「暂停/继续」按钮（沙盒页面经 preload 转发）
  ipcMain.on('overlay:pause', () => runner.pauseTask())
  ipcMain.on('overlay:resume', () => runner.resumeTask())

  ipcMain.handle('debug:extract', async () => {
    const res = await executor.extract()
    return {
      count: res.candidates.length,
      totalFound: (res as any).totalFound ?? res.candidates.length,
      lines: formatCandidates(res).split('\n').slice(0, 120),
      title: res.title,
      url: res.url
    }
  })

  ipcMain.on('layout:browser-rect', (_e, rect) => {
    tabManager?.setBrowserRect(rect)
  })

  ipcMain.on('layout:browser-hidden', (_e, hidden: boolean) => {
    tabManager?.setBrowserHidden(hidden)
  })
}

const gotLock = isFastllmTest(process.argv) || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    registerIpc()
    if (isFastllmTest(process.argv)) {
      await runFastllmTest((code) => app.exit(code))
      return
    }
    if (process.argv.includes('--selftest')) {
      await runSelftest({
        createWindow,
        getTabManager: () => tabManager,
        getExecutor: () => executor,
        getUiWebContents: () => win?.webContents,
        getWin: () => win,
        exit: (code) => app.exit(code)
      })
      return
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
