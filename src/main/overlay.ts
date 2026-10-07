import { BrowserWindow, WebContentsView } from 'electron'
import { app } from 'electron'
import { join } from 'path'

/**
 * 鼠标轨迹可视化覆盖层：独立透明 WebContentsView 叠在浏览器视图上方，
 * 绘制幽灵光标、移动拖尾与点击波纹。不触碰页面 DOM（风控站点安全）。
 * CDP Input 事件直接注入目标 webContents，不受覆盖层遮挡影响。
 *
 * AI 工作期间整块覆盖层拦截用户鼠标（页面只允许 AI 操作），
 * 顶部渲染「AI 操作中」状态条 + 暂停按钮（经 preload IPC 回主进程）。
 */
export class Overlay {
  private win: BrowserWindow
  private view: WebContentsView
  private shown = false
  private working = false
  private hideTimer: NodeJS.Timeout | null = null
  private bounds: Electron.Rectangle | null = null
  /** 最近一次推送的状态条文本（重新显示时恢复） */
  private lastStatus = ''

  constructor(win: BrowserWindow) {
    this.win = win
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        preload: app.isPackaged
          ? join(process.resourcesPath, 'overlay-preload.js')
          : join(__dirname, '../../resources/overlay-preload.js')
      }
    })
    this.view.setBackgroundColor('#00000000')
    const html = app.isPackaged ? join(process.resourcesPath, 'overlay.html') : join(__dirname, '../../resources/overlay.html')
    this.view.webContents.loadFile(html).catch((e) => console.error('[overlay] 加载失败:', e))
    // 双保险：页面加载完成时重放当前状态（覆盖 ready 探测超时的边缘时序，保证任务开头遮罩不丢）
    this.view.webContents.on('did-finish-load', () => {
      this.js(`window.__ovl && window.__ovl.setWorking(${this.working})`)
      if (this.lastStatus) this.js(`window.__ovl && window.__ovl.setStatus(${JSON.stringify(this.lastStatus)})`)
      if (this.working && this.shown) this.attach()
    })
  }

  /** 浏览器区域变化时同步（保持在最上层） */
  refit(bounds: Electron.Rectangle | null, browserHidden: boolean): void {
    this.bounds = bounds
    if (!this.shown || browserHidden || !bounds) {
      this.detach()
      return
    }
    this.attach(bounds)
  }

  private attach(bounds?: Electron.Rectangle): void {
    const b = bounds || this.bounds
    if (!b) return
    try {
      // 常驻挂载 + 可见性切换（避免反复拆装视图）；仅在不在最顶层时重新置顶（页签切换会把页签视图压到覆盖层上面）
      const cv = this.win.contentView
      if (cv.children[cv.children.length - 1] !== this.view) {
        cv.removeChildView(this.view)
        cv.addChildView(this.view)
      }
      this.view.setBounds(b)
      this.view.setVisible(true)
    } catch {}
  }

  private detach(): void {
    try {
      this.view.setVisible(false)
    } catch {}
  }

  private js(code: string): Promise<unknown> {
    // 先等遮罩页面脚本就绪再执行——应用冷启动后立即开始任务时页面可能尚未加载完，
    // 直接执行会被 `window.__ovl &&` 短路丢失（表现为任务开头数秒无遮罩）
    // 保险丝：不可见视图的渲染器被 Chromium 挂起时 executeJavaScript 永不 settle，
    // 遮罩是纯视觉装饰，绝不允许它挂死 Agent 循环（2s 超时静默放弃）
    const exec = this.ready().then(() => this.view.webContents.executeJavaScript(code, true)).then(() => undefined)
    return Promise.race([exec, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000).unref?.())]).catch(
      () => undefined
    )
  }

  private readyPromise: Promise<void> | null = null

  /** 等待遮罩页面 __ovl 脚本就绪（最多 6 秒，之后视为永久就绪避免重复等待） */
  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            const ok = await this.view.webContents.executeJavaScript('typeof window.__ovl === "object"', true)
            if (ok) return
          } catch {}
          await new Promise((r) => setTimeout(r, 150))
        }
      })().catch(() => undefined)
    }
    return this.readyPromise
  }

  /** 开始一批动作：显示覆盖层（延迟隐藏计时取消） */
  async begin(): Promise<void> {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.shown) {
      await this.ready()
      return
    }
    this.shown = true
    this.attach()
    await this.ready()
  }

  /** AI 工作状态：true 时持续显示（淡蓝遮罩+水波纹+顶部状态条），false 时若无动作批则隐藏 */
  setWorking(working: boolean): void {
    this.working = working
    if (working) {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer)
        this.hideTimer = null
      }
      if (!this.shown) {
        this.shown = true
        this.attach()
      }
      // 恢复状态条文本（页面侧状态条随 working 显隐）
      this.js(`window.__ovl && window.__ovl.setStatus(${JSON.stringify(this.lastStatus)})`)
    } else {
      // 停止工作：若没有待隐藏计时则安排隐藏（清掉墨迹）
      if (this.shown && !this.hideTimer) this.end()
    }
    this.js(`window.__ovl && window.__ovl.setWorking(${working})`)
  }

  /** 更新顶部状态条副文本（如「第 3 步：模型思考中…」） */
  setStatusText(text: string): void {
    if (text === this.lastStatus) return
    this.lastStatus = text
    this.js(`window.__ovl && window.__ovl.setStatus(${JSON.stringify(text)})`)
  }

  /** 结束一批动作：600ms 后自动隐藏（期间可被下一批 begin 打断） */
  end(): void {
    if (!this.shown) return
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      // 工作中保持显示（光晕），只清墨迹
      this.js('window.__ovl && window.__ovl.clear()')
      if (!this.working) {
        this.shown = false
        this.detach()
      }
    }, 700)
  }

  /** 光标滑向目标点（等待动画完成） */
  async moveTo(x: number, y: number): Promise<void> {
    await this.js(`window.__ovl && window.__ovl.moveTo(${x}, ${y})`)
  }

  /** 拖动步进：光标快速跟到拖动路径上的下一点（拖尾实时渲染） */
  async dragStep(x: number, y: number): Promise<void> {
    await this.js(`window.__ovl && window.__ovl.dragStep(${x}, ${y})`)
  }

  /** 点击波纹 */
  async click(x: number, y: number): Promise<void> {
    await this.js(`window.__ovl && window.__ovl.click(${x}, ${y})`)
  }

  /** 调试/自测：模拟点击顶部「暂停」按钮（走真实 preload→IPC 链路） */
  async debugClickPause(): Promise<void> {
    await this.js('var b = document.getElementById("btn-pause"); b && b.click()')
  }

  forceHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.shown = false
    this.detach()
  }

  /** 调试/自测：读取动画状态（光标位置、累计移动/点击数、状态条）+ 主进程侧视图诊断 */
  async debugState(): Promise<Record<string, unknown> | null> {
    let diag: Record<string, unknown> = {}
    try {
      const kids = this.win.contentView.children
      diag.isLast = kids.length ? kids[kids.length - 1] === this.view : false
      diag.childCount = kids.length
      diag.mainShown = this.shown
      diag.mainWorking = this.working
      diag.bounds = this.bounds
      try {
        diag.viewVisible = (this.view as unknown as { getVisible(): boolean }).getVisible()
      } catch {}
    } catch {}
    try {
      const page = await this.view.webContents.executeJavaScript('window.__ovl ? window.__ovl.state() : null', true)
      return page ? { ...page, ...diag } : null
    } catch {
      return null
    }
  }
}
