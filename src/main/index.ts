import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { TabManager, chromeLikeUA } from './tabs'
import { Executor } from './executor'
import { AgentRunner } from './agent/runner'
import { Overlay } from './overlay'
import { getSettings, saveSettings, sanitizeSettingsPatch, settingsReloadAfterReady } from './settings'
import { getKB, setKB } from './knowledge'
import { getExperience, setExperience, flushExperience } from './experience'
import { getTemplates, saveTemplate, deleteTemplate, resolveTemplateVars } from './templates'
import { createProvider, isVisionUnsupportedError, probeStructuredSupport, TINY_TEST_IMAGE } from './agent/llm'
import { ENHANCE_SYSTEM_PROMPT } from './agent/prompts'
import { listCCSwitchProviders } from './ccswitch'
import { recordHistory, touchHistoryTitle, listHistory, removeHistory, clearHistory } from './history'
import { formatCandidates } from './extractor'
import { runSelftest } from './selftest'
import { runRegression } from './regression'
import { runFastllmTest, isFastllmTest } from './fastllm-test'
import { tryInitOcr, ocrEnhanceExtract, ocrPageText, disposeOcr } from './ocr'
import { FastLlm } from './fastllm'
import { Asr } from './asr'
import { Scheduler } from './scheduler'
import { onCleanup, runCleanup, forceExitAfter } from './cleanup'
import { convertRequirement } from './testcase/converter'
import { summarize } from './testcase/parser'
import { parseTestSuite, selectFailedCases } from './testcase/suite'
import { runTestingSelftest } from './testcase/selftest'
import { benchmarkModel } from './testcase/modelBenchmark'
import { writeJsonAtomic } from './fsutil'
import { stepPreview, updateStep, deleteStep, insertStep } from './testcase/edit'
import { planFormFill } from './testcase/fields'
import { reportsRoot, renderCaseMd } from './testcase/report'
import {
  getTestEnvs,
  saveTestEnvs,
  findTestEnv,
  listReports,
  readReport,
  listTestCases,
  saveTestCase,
  deleteTestCase,
  getTestCase
} from './testcase/store'
import type { KBEntry, MainEvent, Schedule, Settings, TestCase, TestEnv } from '@shared/types'

// 安全警告只在开发态抑制（生产态保留，便于发现 IPC/证书类问题）
if (!app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// 后台/最小化运行支持（默认关）：抑制 Chromium 后台节流（渲染/定时器/被遮挡窗口），
// 保证测试或任务在窗口最小化时仍全速执行。commandLine 开关须在 app ready 前设置，故重启生效。
// 默认关闭=与历史行为逐字节一致（开关只在设置里显式打开才追加）。
// 自动验收不依赖窗口是否处于前台；共享桌面焦点切换不应让 CDP 输入等待数分钟。
const automationRuntime = process.argv.some((arg) => ['--selftest', '--testing-selftest', '--regression'].includes(arg))
if (getSettings().bgRun || automationRuntime) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

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
let asrMgr: Asr
let scheduler: Scheduler

/* —— 托盘与关闭行为（用户反馈：关闭后进程残留、托盘看不到图标） —— */
let tray: Tray | null = null
let trayBalloonShown = false
/** 真正退出标记：close 拦截（最小化到托盘）只在非退出路径生效。
 *  注意与下方 shutdown 的防重入标志相互独立——reallyQuit 先置本标记再 app.quit()，
 *  before-quit 的清理必须照常执行（否则退出时不释放任何资源） */
let quitting = false

function trayIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'tray.png') : join(__dirname, '../../resources/tray.png')
}

/** 窗口图标（dev 下默认是 Electron 图标，显式指定与安装图标同源） */
function windowIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app-icon.png') : join(__dirname, '../../resources/app-icon.png')
}

function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) {
    console.warn('[easybow] 托盘图标加载失败:', trayIconPath())
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('EasyBow — AI 浏览器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 EasyBow', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出 EasyBow', click: () => reallyQuit() }
    ])
  )
  tray.on('click', () => showMainWindow())
}

/** 最小化到托盘：窗口隐藏（页面与任务继续跑），首次给一条气泡提示指引 */
function hideToTray(): void {
  createTray()
  if (!win || win.isDestroyed()) return
  win.hide()
  if (!trayBalloonShown) {
    trayBalloonShown = true
    try {
      tray?.displayBalloon?.({
        iconType: 'info',
        title: 'EasyBow 仍在运行',
        content: '窗口已最小化到托盘，后台任务不受影响。点击托盘图标重新打开；右键托盘图标可完全退出。'
      })
    } catch {}
  }
}

/** 真正退出：走 app.quit → before-quit 统一清理（cleanup.ts + 强制退出保险丝） */
function reallyQuit(): void {
  quitting = true
  app.quit()
}

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
    icon: windowIconPath(),
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })
  // R1 指纹一致性：主窗口（UI 渲染器）同样使用自洽 Chromium UA（站点页签在 TabManager 侧设置）
  win.webContents.setUserAgent(chromeLikeUA())

  win.on('resize', () => tabManager?.onWindowResized())
  win.on('closed', () => {
    win = null
  })

  // 关闭行为（用户反馈：点关闭后进程残留、托盘又看不到图标，不知道程序还在跑）：
  // close 默认拦截——按设置分流为「最小化到托盘 / 退出」；每次询问时弹窗并可记住选择。
  // 最小化到托盘时窗口只是隐藏，AI 任务与页签继续跑；退出走 reallyQuit 统一清理。
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    const act = getSettings().closeAction || 'ask'
    if (act === 'tray') {
      hideToTray()
      return
    }
    if (act === 'exit') {
      reallyQuit()
      return
    }
    const w = win
    if (!w || w.isDestroyed()) return
    void (async () => {
      const st = runner?.getStatus().state
      const running = st === 'running' || st === 'paused' || st === 'captcha'
      const r = await dialog.showMessageBox(w, {
        type: 'question',
        buttons: ['最小化到托盘', '退出程序'],
        defaultId: running ? 0 : 1,
        cancelId: 1,
        checkboxLabel: '记住我的选择，不再询问',
        title: '关闭 EasyBow',
        message: '要最小化到托盘，还是退出程序？',
        detail: running
          ? 'AI 任务正在运行：最小化到托盘不会中断任务，可从右下角托盘图标回到窗口；退出程序会中断当前任务。'
          : '最小化到托盘后可从右下角托盘图标快速回到窗口；退出程序将完全关闭 EasyBow。'
      })
      if (w.isDestroyed()) return
      if (r.response === 0) {
        if (r.checkboxChecked) saveSettings({ closeAction: 'tray' })
        hideToTray()
      } else {
        if (r.checkboxChecked) saveSettings({ closeAction: 'exit' })
        reallyQuit()
      }
    })()
  })

  // 托盘常驻（新托盘图标 Windows 默认收进溢出区 ^，可拖到可见区）：关闭窗口后仍给用户入口
  createTray()

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
  onCleanup(() => clearInterval(hbTimer))
  // 自愈后重新上报浏览器区域（新渲染器启动时也会自行上报，这里兜底）
  win.webContents.on('did-finish-load', () => tabManager?.onWindowResized())

  tabManager = new TabManager(win, broadcast)
  // 浏览历史：导航即记录，标题更新回填
  tabManager.onHistory = (url, title) => recordHistory(url, title)
  tabManager.onTitle = (url, title) => touchHistoryTitle(url, title)
  executor = new Executor(tabManager)
  executor.setMaxElementsProvider(() => getSettings().maxElements)
  tabManager.onTabClosed = (id) => executor.dropSnapshots(id)
  // 智能表单填充的 LLM 规划钩子（fill_form 动作触发时调用；provider 每次按当前设置新建）
  executor.formFillPlanner = (fields, ctx) => {
    const s = getSettings()
    if (!s.apiKey) return Promise.reject(new Error('智能填充需要先在「设置」中配置 AI 接口'))
    return planFormFill(createProvider(s), fields, ctx)
  }
  // v4.4 点击放大复核器（密集歧义/写操作点击前的视觉确认，宁可不点不可点错）：
  // 目标局部截图 + 预期文案 → 视觉模型判定是否同一控件；未配置/超时/解析失败一律降级放行
  // v4.6 A2：provider 按设置缓存复用（此前每次点击都新建客户端实例）；用量进 llm_call 分账（site=clickVerify）
  let clickVerifyProvider: ReturnType<typeof createProvider> | null = null
  let clickVerifyProviderKey = ''
  executor.clickVerifier = async (crop, expect, label) => {
    const s = getSettings()
    if (!s.apiKey) return { ok: true }
    try {
      const pvKey = `${s.provider}|${s.baseURL}|${s.apiKey}|${s.model}`
      if (!clickVerifyProvider || clickVerifyProviderKey !== pvKey) {
        clickVerifyProvider = createProvider(s)
        clickVerifyProviderKey = pvKey
      }
      const res = await Promise.race([
        clickVerifyProvider.chat(
          '你是点击前的目标核验员。用户即将点击一个控件，附带目标区域的局部截图。' +
            '判断截图中央的控件是否与「预期文案」指向同一个操作目标（文字或图标语义大致相符即算匹配）。' +
            '只输出纯 JSON：{"ok":true} 或 {"ok":false,"reason":"不匹配原因（20字内）"}',
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: `预期文案：${expect || label}（当前控件文案：${label}）` },
                { type: 'image', dataUrl: crop }
              ]
            }
          ],
          undefined,
          { plain: true, maxTokens: 256 }
        ),
        new Promise<null>((r) => setTimeout(() => r(null), 20000))
      ])
      if (!res) return { ok: true }
      try {
        runner?.logEvent('llm_call', (runner?.currentStep || 0) + 1, {
          site: 'clickVerify',
          local: false,
          vision: true,
          planner: false,
          input: res.usage.inputTokens,
          output: res.usage.outputTokens,
          cachedIn: res.usage.cachedInputTokens
        })
      } catch {}
      const m = /"ok"\s*:\s*(true|false)/i.exec(res.text)
      if (!m) return { ok: true }
      const reason = /"reason"\s*:\s*"([^"]{0,80})"/.exec(res.text)?.[1]
      return { ok: m[1].toLowerCase() === 'true', reason }
    } catch {
      return { ok: true }
    }
  }
  runner = new AgentRunner(tabManager, executor, sendEvent)
  // v4.6 D1：clickVerifier 分档决策日志（run/skip + 原因）→ telemetry action_verify 事件
  executor.clickVerifyHook = (ev) => {
    try {
      runner?.logEvent('action_verify', (runner?.currentStep || 0) + 1, { clickVerify: ev.decision, reason: ev.reason })
    } catch {}
  }
  // 本地快速决策模型（混合模式）：ready 前不参与决策，任务零影响
  fastllm = new FastLlm(sendEvent)
  runner.fastllm = fastllm
  // 定时任务：到点自动执行（AI 空闲时）；倒计时/取消经事件推送。
  // 绑定测试用例的条目到点跑定时回归（独立测试页签+报告），普通条目仍走自由任务
  scheduler = new Scheduler(
    sendEvent,
    (s) => {
      if (s.testCaseId != null) {
        const entry = getTestCase(s.testCaseId)
        if (!entry) return Promise.reject(new Error(`定时回归用例 ${s.testCaseId} 已被删除，请编辑该定时任务`))
        // 定时回归同样解析环境档案：生产保护（env.protected）不因「到点自动触发」而失效
        //（复核 P1-11：此前定时路径不传 env，指向生产的用例到点无人确认自动提交/删除）
        const env = findTestEnv(s.envName)
        return runner.startTestRun(entry.md, {
          failFast: true,
          caseId: entry.id,
          env: env ? { name: env.name, baseUrl: env.baseUrl, protected: env.protected } : undefined
        })
      }
      return runner.startTask(s.task)
    },
    () => {
      const st = runner.getStatus().state
      return st === 'idle' || st === 'done' || st === 'error' || st === 'stopped'
    }
  )
  scheduler.start()
  const overlay = new Overlay(win)
  executor.overlay = overlay
  tabManager.onLayout = (rect, hidden) => overlay.refit(rect, hidden)
  // 退出清理：覆盖层（原生视图）/ OCR 隐藏窗口 / 定时任务 / 心跳看门狗 / 页签与 CDP 会话
  // 不释放会留下后台残留进程，下次启动撞单实例锁或缓存锁（表现为「关闭后打不开」）
  onCleanup(() => overlay.destroy())
  onCleanup(() => disposeOcr())
  onCleanup(() => scheduler.stop())
  onCleanup(() => runner.dispose())
  onCleanup(() => flushExperience())
  onCleanup(() => fastllm.dispose())
  onCleanup(() => tabManager.destroyAll())

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
  // v4.4 语音输入管理器（本地 whisper，独立进程推理）；退出时释放
  asrMgr = new Asr(sendEvent)
  onCleanup(() => asrMgr?.dispose())
  // v4.4 麦克风权限：仅放行 UI 窗口（默认会话）的 media 请求；站点页签走独立会话、
  // 维持 Electron 默认策略（不给站点开麦克风）
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(!!win && wc === win.webContents)
    callback(true)
  })

  ipcMain.handle('settings:get', () => getSettings())
  // 渲染进程不可信（C5）：只接受白名单字段 + 类型/枚举/范围校验，非法字段静默丢弃保留原值
  ipcMain.handle('settings:set', (_e, s: Settings) => saveSettings(sanitizeSettingsPatch(s)))
  ipcMain.handle('kb:get', () => getKB())
  ipcMain.handle('kb:set', (_e, entries: KBEntry[]) => setKB(entries))
  // 自动经验库（S5：AI 任务中自动沉淀；UI 查看与删除）
  ipcMain.handle('exp:get', () => getExperience())
  ipcMain.handle('exp:set', ok((entries: import('@shared/types').ExperienceEntry[]) => setExperience(Array.isArray(entries) ? entries : [])))
  // 任务模板（任务输入快速填充）
  ipcMain.handle('templates:get', () => getTemplates())
  ipcMain.handle('templates:save', ok((t: { id?: number; name: string; group?: string; text: string; pinned?: boolean }) => saveTemplate(t)))
  ipcMain.handle('templates:delete', ok((id: number) => deleteTemplate(Number(id))))
  ipcMain.handle('templates:resolve', ok((text: string) => {
    const tab = tabManager.active()
    return resolveTemplateVars(String(text || ''), tab ? { title: tab.title || '', url: tab.url || '' } : undefined)
  }))
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
  // v4.4 语音输入（本地 whisper，离线免费）：渲染层录音 PCM → 文本（独立进程推理，主进程不卡）
  ipcMain.handle(
    'asr:transcribe',
    ok(async (pcm: Float32Array | number[], sampleRate: number) => {
      try {
        const buf = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm || [])
        const text = await asrMgr.transcribe(buf, Number(sampleRate) || 16000)
        return { ok: true, text }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    })
  )
  ipcMain.handle('llm:test', async () => {
    const s = getSettings()
    const provider = createProvider(s)
    // T4 结构化输出预检（1-token 探测，不消耗真实任务请求；结果会话内粘滞，预检日志可见）
    const probeNote = async (): Promise<string> => {
      if (s.structuredOut === false) return '结构化输出: 已关闭'
      try {
        const sup = await probeStructuredSupport(s)
        return `结构化输出: ${sup === 'json_schema' ? 'json_schema ✅' : sup === 'json_object' ? 'json_object（降级）' : '不支持（纯文本 JSON）'}`
      } catch {
        return '结构化输出: 探测失败（按纯文本 JSON）'
      }
    }
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
        return {
          ok: true,
          message: `连接成功，支持视觉输入 ✅（模型回复: ${r.text.slice(0, 30)}；${await probeNote()}）`,
          usage: r.usage
        }
      } catch (e: any) {
        if (isVisionUnsupportedError(e)) {
          // 纯文本再测一次，确认连接本身可用（运行时视觉模式会自动降级）
          const r2 = await provider.chat('你是连接测试助手。只输出两个字：正常', [
            { role: 'user', content: 'ping' }
          ])
          return {
            ok: true,
            message: `连接成功，但模型不接受图片输入 ⚠️ 运行时视觉模式将自动降级为元素列表（纯文本回复: ${r2.text.slice(0, 20)}；${await probeNote()}）`,
            usage: r2.usage
          }
        }
        throw e
      }
    }
    const r = await provider.chat('你是连接测试助手。只输出两个字：正常', [
      { role: 'user', content: 'ping' }
    ])
    return { ok: true, message: `连接成功，模型回复: ${r.text.slice(0, 50)}（${await probeNote()}）`, usage: r.usage }
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
  // 人工批准当前节点通过（跳过其复核并推进；暂停中自动继续）
  ipcMain.handle('agent:approveNode', ok(() => runner.approveNode()))
  // 清空显示：时间线/任务记忆/状态回到空闲
  ipcMain.handle('agent:clearDisplay', ok(() => runner.clearDisplay()))
  // 任务描述 AI 增强（✨ 按钮）：格式 + 内容增强，只改写任务文本、不启动任务
  ipcMain.handle(
    'agent:enhanceTask',
    ok(async (task: string) => {
      const s = getSettings()
      if (!s.apiKey) throw new Error('请先在「设置」中配置 AI 接口（baseURL / API Key / 模型）')
      const provider = createProvider(s)
      const out = await provider.chat(ENHANCE_SYSTEM_PROMPT, [{ role: 'user', content: String(task || '').slice(0, 4000) }])
      const text = (out.text || '').trim().replace(/```(?:\w+)?/g, '').trim()
      if (!text) throw new Error('增强结果为空，请重试')
      return text.slice(0, 8000)
    })
  )

  // —————— 浏览器仿真测试 ——————
  // 需求 MD → 多用例 MD（全文分段转换，不占页签）
  ipcMain.handle('test:convert', async (_e, reqMd: string, mode: 'prd' | 'rough') => {
    const s = getSettings()
    if (!s.apiKey) throw new Error('请先在「设置」中配置 AI 接口')
    return convertRequirement(createProvider(s), String(reqMd || ''), mode === 'prd' ? 'prd' : 'rough')
  })
  // 用例 MD 校验（UI 预览步骤/断言/变量/数据组 + 步骤节点明细，供面板行内编辑后重渲染）
  ipcMain.handle('test:parse', (_e, md: string) => {
    const r = parseTestSuite(String(md || ''))
    if (!r.ok || !r.suite) return { ok: false, error: r.error }
    const tc = { name: r.suite.name, vars: Object.assign({}, ...r.suite.cases.map((c) => c.vars)), steps: r.suite.cases.flatMap((c) => c.steps) }
    const s = summarize(tc)
    return {
      ok: true,
      name: r.suite.name,
      cases: r.suite.cases.length,
      unresolved: tc.steps.flatMap((s) => s.assertions).filter((a) => a.kind === 'ai').length,
      steps: s.steps,
      assertions: s.assertions,
      vars: s.vars,
      groups: r.suite.cases.reduce((n, c) => n + (c.groups?.length || 1), 0),
      stepsDetail: stepPreview(tc)
    }
  })
  // 行内编辑单步骤：改/删/插 → 返回新用例 MD（面板据此重新解析，其下方节点一并重建）
  ipcMain.handle(
    'test:editStep',
    (_e, md: string, index: number, patch: any) => {
      const src = String(md || '')
      const i = Number(index)
      if (!patch || typeof patch !== 'object') return { ok: false, error: '缺少编辑内容' }
      if (patch.op === 'delete') return deleteStep(src, i)
      if (patch.op === 'insert') {
        return insertStep(src, i, { title: patch.title, action: patch.action, assertions: patch.assertions })
      }
      return updateStep(src, i, {
        title: patch.title,
        action: patch.action,
        assertions: Array.isArray(patch.assertions) ? patch.assertions : undefined,
        dialog: patch.dialog
      })
    }
  )
  // 运行测试（环境档案按名解析：base_url 注入记忆 + 生产保护标记；fillPreview=智能填充前人工预览；
  // loginReuse=启动先探测已保存登录态，命中则跳过登录步骤）
  ipcMain.handle(
    'test:start',
    ok((md: string, opts: { envName?: string; failFast: boolean; fillPreview?: boolean; loginReuse?: boolean; reusePlans?: boolean }) => {
      const env = findTestEnv(opts?.envName)
      return runner.startTestRun(String(md || ''), {
        failFast: opts?.failFast !== false,
        fillPreview: !!opts?.fillPreview,
        loginReuse: opts?.loginReuse === true,
        reusePlans: opts?.reusePlans !== false,
        env: env ? { name: env.name, baseUrl: env.baseUrl, protected: env.protected } : undefined
      })
    })
  )
  ipcMain.handle('test:stop', () => runner.stopTask())
  let benchmarking = false
  ipcMain.handle('test:model-benchmark', async () => {
    if (benchmarking) throw new Error('模型测评正在运行')
    const settings = getSettings()
    if (!settings.apiKey) throw new Error('请先配置 AI 接口')
    benchmarking = true
    try {
      const report = await benchmarkModel(createProvider(settings), settings)
      mkdirSync(join(app.getPath('userData'), 'model-capabilities'), { recursive: true })
      writeJsonAtomic(join(app.getPath('userData'), 'model-capabilities', `${report.profileId}-${report.testedAt}.json`), report)
      return report
    } finally { benchmarking = false }
  })
  ipcMain.handle('test:status', () => runner.getTestRunStatus())
  // 强制重置卡在「执行中」的测试状态（UI 看门狗/用户手动兜底）
  ipcMain.handle('test:reset', () => runner.resetTestRun())
  // 用例库：列表/保存（带 id 更新）/删除
  ipcMain.handle('cases:get', () => listTestCases())
  ipcMain.handle(
    'cases:save',
    ok((entry: { name: string; md: string; tags?: string[]; id?: number }) =>
      saveTestCase({ name: String(entry?.name || ''), md: String(entry?.md || ''), tags: entry?.tags, id: entry?.id })
    )
  )
  ipcMain.handle('cases:delete', ok((id: number) => deleteTestCase(Number(id))))
  // 失败重跑：按步骤序号选择完整用例/数据组，保留其准备与清理（返回编辑器审核）
  ipcMain.handle('test:subcase', (_e, md: string, keepIdx: number[], suffix?: string) => {
    const r = parseTestSuite(String(md || ''))
    if (!r.ok || !r.suite) return { ok: false, error: r.error }
    const indices = (Array.isArray(keepIdx) ? keepIdx : []).filter((n) => Number.isInteger(n) && n > 0)
    const cases = selectFailedCases(r.suite, indices)
    if (!cases.length) return { ok: false, error: '没有可重跑的失败用例' }
    return { ok: true, md: `# TESTSUITE: ${r.suite.name}${suffix || '-失败重跑'}\n\n` + cases.map(renderCaseMd).join('\n\n') }

  })
  ipcMain.handle('test:reports', () => listReports())
  ipcMain.handle('test:report-read', ok((file: string) => readReport(file)))
  ipcMain.handle('test:reports-open', async () => {
    await shell.openPath(reportsRoot())
    return true
  })
  ipcMain.handle('testenvs:get', () => getTestEnvs())
  ipcMain.handle('testenvs:set', ok((envs: TestEnv[]) => saveTestEnvs(Array.isArray(envs) ? envs : [])))

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

// 自测模式：独立临时 userData + 绕过单实例锁，保证开发者开着正式应用也能随时跑自测
// （共享真实 profile 会撞 Chromium 缓存锁，且定时任务/浏览历史会被自测污染）
const isTestingSelftest = process.argv.includes('--testing-selftest')
const isSelftest = process.argv.includes('--selftest') || isTestingSelftest
if (isSelftest) {
  app.setPath('userData', join(app.getPath('temp'), `easybow-selftest-${Date.now()}`))
}

// 回归模式（--regression）：同样独立临时 userData + 免单实例锁（跑完出报告即退出）
const isRegression = process.argv.includes('--regression')
if (isRegression) {
  app.setPath('userData', join(app.getPath('temp'), `easybow-regression-${Date.now()}`))
}

const gotLock = isFastllmTest(process.argv) || isSelftest || isRegression || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else {
      showMainWindow()
    }
  })

  app.whenReady().then(async () => {
    // safeStorage 需要 ready：此刻重新读盘解密 apiKey（模块顶层那次只读了布尔开关）
    settingsReloadAfterReady()
    registerIpc()
    if (isFastllmTest(process.argv)) {
      await runFastllmTest((code) => app.exit(code))
      return
    }
    if (isSelftest) {
      if (isTestingSelftest) {
        createWindow()
        const timeout = setTimeout(() => { console.error('Testing selftest timeout'); app.exit(1) }, 120000)
        const code = await runTestingSelftest(tabManager, executor).catch((e) => { console.error(e); return 1 })
        clearTimeout(timeout)
        app.exit(code)
        return
      }
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
    if (isRegression) {
      await runRegression()
      return
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 退出清理：先释放全部长生命周期资源，再退出；保险丝兜底强制结束进程，
  // 杜绝「窗口关了、进程还在后台占着锁，下次启动打不开」。
  // shuttingDown 是清理防重入（多次 before-quit/quit），与 close 拦截的 quitting 互不影响
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await runCleanup()
    } catch {}
    forceExitAfter(2500, 0)
  }
  app.on('before-quit', () => {
    void shutdown()
  })
  app.on('window-all-closed', () => {
    // 自测/回归模式下**不退出**：这两套用例过程中会开关浏览器视图与测试页签，
    // 一旦某一刻窗口数归零就会触发 window-all-closed 把进程带走——表现为
    // 用例跑到一半静默结束、不打印汇总、却返回 exit 0。
    // 这正是第 10 节之后的用例（含密集控件定位基准、iframe 全穿透）长期
    //「写在代码里但从不执行」的原因：不是用例有问题，是进程先没了。
    if (isSelftest || isRegression) return
    app.quit()
  })
  // 兜底：所有窗口已关闭但进程仍未退出（残留句柄），2s 后无条件结束
  app.on('quit', () => {
    void shutdown()
  })
}
