import { BrowserWindow, WebContentsView, session, app, Notification } from 'electron'
import { join } from 'path'
import { Cdp } from './cdp'
import { MAX_TABS, type TabInfo } from '@shared/types'

export interface Broadcast {
  (channel: string, payload: unknown): void
}

export interface Tab {
  id: number
  view: WebContentsView
  cdp: Cdp
  title: string
  url: string
  loading: boolean
  /** 会话分区（普通页签缺省=共享持久分区；测试页签用独立分区隔离登录态） */
  partition?: string
}

/** 测试页签专用会话分区：与日常浏览的登录态/Cookie 互不污染 */
export const TEST_PARTITION = 'persist:easybow-test'

let nextTabId = 1

/**
 * 多页签管理：所有页签共享同一个持久会话（persist:easybow），
 * 站点登录一次全页签生效。最多 5 个页签。
 */
export class TabManager {
  private win: BrowserWindow
  private tabs: Tab[] = []
  private activeId = -1
  private broadcast: Broadcast
  private browserRect: { x: number; y: number; width: number; height: number } | null = null
  private ses: Electron.Session
  /** 浏览器视图是否被临时隐藏（设置弹窗/截图查看器打开时，避免原生视图盖住 UI） */
  private browserHidden = false
  /** 布局变化后的回调（覆盖层同步用） */
  onLayout: ((rect: { x: number; y: number; width: number; height: number } | null, hidden: boolean) => void) | null = null
  /** 导航发生回调（浏览历史记录用）：url + 当时的页签标题 */
  onHistory: ((url: string, title: string) => void) | null = null

  /** 页签关闭回调（执行器据此清理该页签的提取快照） */
  onTabClosed: ((id: number) => void) | null = null
  /** 页面标题更新回调（历史记录回填标题用） */
  onTitle: ((url: string, title: string) => void) | null = null

  constructor(win: BrowserWindow, broadcast: Broadcast) {
    this.win = win
    this.broadcast = broadcast
    this.ses = session.fromPartition('persist:easybow')
    this.ses.setSpellCheckerEnabled(false)

    // 下载处理：自动保存到系统下载目录
    this.ses.on('will-download', (_e, item) => {
      const dir = app.getPath('downloads')
      const safe = item.getFilename().replace(/[\\/:*?"<>|]/g, '_') || 'easybow-download'
      item.setSavePath(join(dir, safe))
      this.broadcast('toast', { message: `开始下载: ${safe}`, kind: 'info' })
      item.once('done', (_e2, state) => {
        if (state === 'completed') {
          this.broadcast('toast', { message: `下载完成: ${safe}（已保存到下载目录）`, kind: 'success' })
        } else if (state !== 'cancelled') {
          this.broadcast('toast', { message: `下载失败: ${safe} (${state})`, kind: 'error' })
        }
      })
    })
  }

  getSession(): Electron.Session {
    return this.ses
  }

  /** 渲染进程上报浏览器区域位置（窗口内容坐标 DIP） */
  setBrowserRect(rect: { x: number; y: number; width: number; height: number }): void {
    this.browserRect = rect
    this.layout()
  }

  setBrowserHidden(hidden: boolean): void {
    this.browserHidden = hidden
    this.layout()
  }

  isBrowserHidden(): boolean {
    return this.browserHidden
  }

  private layout(): void {
    const t = this.tabs.find((x) => x.id === this.activeId)
    if (!t) return
    if (!this.browserRect) return
    const r = this.browserRect
    if (this.browserHidden) {
      // 隐藏：只切可见性（webContents 保持存活，登录态/页面状态不丢）。
      // 不做 removeChildView 反复拆装视图——高频 resize/弹窗开合下拆装会放大合成器卡顿，极端时把渲染器卡死
      t.view.setVisible(false)
    } else {
      const cv = this.win.contentView
      if (!cv.children.includes(t.view)) {
        // 页签切换：卸载其他页签视图，挂载当前页签
        for (const other of this.tabs) {
          if (other.id !== t.id && cv.children.includes(other.view)) cv.removeChildView(other.view)
        }
        cv.addChildView(t.view)
      }
      t.view.setBounds(r)
      t.view.setVisible(true)
    }
    if (process.env.EASYBOW_DEBUG) {
      console.log(
        `[layout] tab=${t.id} hidden=${this.browserHidden} bounds=`,
        JSON.stringify(r),
        `children=${this.win.contentView.children.length}`
      )
    }
    this.onLayout?.(r, this.browserHidden)
  }

  onWindowResized(): void {
    this.layout()
  }

  newTab(url?: string, opts?: { partition?: string }): { tabs: TabInfo[]; activeTabId: number } {
    if (this.tabs.length >= MAX_TABS) {
      this.broadcast('toast', { message: `最多 ${MAX_TABS} 个页签，请先关闭其他页签`, kind: 'error' })
      return this.snapshot()
    }
    // 指定 partition 的页签用独立会话（测试页签隔离登录态）；普通页签行为与历史版本一致
    const ses = opts?.partition ? session.fromPartition(opts.partition) : this.ses
    const view = new WebContentsView({
      webPreferences: {
        session: ses
      }
    })
    const wc = view.webContents
    const tab: Tab = {
      id: nextTabId++,
      view,
      cdp: new Cdp(wc),
      title: '新页签',
      url: url || '',
      loading: false,
      partition: opts?.partition
    }

    wc.setWindowOpenHandler(({ url: openUrl }) => {
      // 弹窗/新窗口一律转为我们的页签（不超出上限）
      if (openUrl && /^https?:/i.test(openUrl)) {
        setTimeout(() => this.newTab(openUrl), 0)
      }
      return { action: 'deny' }
    })

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.title
      if (tab.url && title) this.onTitle?.(tab.url, title)
      this.emitTabs()
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      this.emitTabs()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.emitTabs()
    })
    wc.on('did-navigate', (_e, url) => {
      tab.url = url
      if (url) this.onHistory?.(url, tab.title)
      this.emitTabs()
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      tab.url = url
      if (url) this.onHistory?.(url, tab.title)
      this.emitTabs()
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') {
        this.broadcast('toast', {
          message: `页签「${tab.title}」渲染进程异常（${details.reason}），正在尝试恢复…`,
          kind: 'error'
        })
        try {
          wc.reload()
        } catch {}
      }
    })
    // 页签页面卡死（主线程阻塞）时自动强杀重建，避免整个应用假死
    wc.on('unresponsive', () => {
      console.warn(`[tabs] 页签「${tab.title}」无响应，尝试恢复`)
      setTimeout(() => {
        try {
          wc.forcefullyCrashRenderer()
          wc.reload()
        } catch {}
      }, 5000)
    })

    this.tabs.push(tab)
    this.activeId = tab.id
    this.layout()
    if (url) {
      wc.loadURL(url).catch((e) => {
        this.broadcast('toast', { message: `页面加载失败: ${e.message}`, kind: 'error' })
      })
    }
    this.emitTabs()
    return this.snapshot()
  }

  closeTab(id: number): { tabs: TabInfo[]; activeTabId: number } {
    const idx = this.tabs.findIndex((x) => x.id === id)
    if (idx === -1) return this.snapshot()
    const tab = this.tabs[idx]
    this.win.contentView.removeChildView(tab.view)
    tab.cdp.destroy()
    try {
      ;(tab.view.webContents as any).destroy?.()
    } catch {}
    this.tabs.splice(idx, 1)
    this.onTabClosed?.(id)

    if (this.tabs.length === 0) {
      // 至少保留一个页签
      return this.newTab()
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      this.activeId = next.id
      this.layout()
    }
    this.emitTabs()
    return this.snapshot()
  }

  switchTab(id: number): { tabs: TabInfo[]; activeTabId: number } {
    if (!this.tabs.find((x) => x.id === id)) return this.snapshot()
    this.activeId = id
    this.layout()
    try {
      this.active()?.view.webContents.focus()
    } catch {}
    this.emitTabs()
    return this.snapshot()
  }

  active(): Tab | undefined {
    return this.tabs.find((x) => x.id === this.activeId)
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((x) => x.id === id)
  }

  all(): Tab[] {
    return this.tabs
  }

  /** 测试页签（独立登录分区；无则 undefined） */
  getTestTab(): Tab | undefined {
    return this.tabs.find((x) => x.partition === TEST_PARTITION)
  }

  /**
   * 取测试页签：已存在则切到它；没有则新建（独立分区、about:blank 起步）并激活。
   * 页签满时抛错（调用方提示用户先关页签），不静默降级到普通页签。
   */
  ensureTestTab(): Tab {
    const existing = this.getTestTab()
    if (existing) {
      this.switchTab(existing.id)
      return existing
    }
    if (this.tabs.length >= MAX_TABS) {
      throw new Error(`页签已达 ${MAX_TABS} 个上限，请先关闭其他页签再运行测试`)
    }
    this.newTab('about:blank', { partition: TEST_PARTITION })
    const t = this.getTestTab()
    if (!t) throw new Error('测试页签创建失败')
    return t
  }

  async navigate(url: string): Promise<void> {
    const t = this.active()
    if (!t) return
    let target = url.trim()
    if (!target) return
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      // 无协议：像域名则补 https，否则按搜索处理
      if (/^[\w-]+(\.[\w-]+)+/.test(target)) target = 'https://' + target
      else target = 'https://www.baidu.com/s?wd=' + encodeURIComponent(target)
    }
    if (!/^https?:|^file:/i.test(target)) return
    t.loading = true
    this.emitTabs()
    try {
      await t.view.webContents.loadURL(target)
    } catch (e: any) {
      this.broadcast('toast', { message: `导航失败: ${e?.message || e}`, kind: 'error' })
    } finally {
      t.loading = false
      this.emitTabs()
    }
  }

  goBack(): void {
    const wc = this.active()?.view.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(): void {
    const wc = this.active()?.view.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(): void {
    try {
      this.active()?.view.webContents.reload()
    } catch {}
  }

  notifyCaptcha(detail: string): void {
    this.broadcast('toast', { message: `检测到验证码：${detail}。已自动暂停，请人工完成后点击「继续」。`, kind: 'captcha' })
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'EasyBow 需要人工处理', body: '检测到滑块/验证码，请在浏览器中手动完成后点击「继续」。' })
        n.show()
      }
      this.win.flashFrame(true)
      setTimeout(() => this.win.flashFrame(false), 4000)
    } catch {}
  }

  snapshot(): { tabs: TabInfo[]; activeTabId: number } {
    return { tabs: this.infoList(), activeTabId: this.activeId }
  }

  infoList(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      canGoBack: (() => {
        try {
          return t.view.webContents.navigationHistory.canGoBack()
        } catch {
          return false
        }
      })(),
      canGoForward: (() => {
        try {
          return t.view.webContents.navigationHistory.canGoForward()
        } catch {
          return false
        }
      })()
    }))
  }

  emitTabs(): void {
    this.broadcast('tabs', this.snapshot())
  }

  destroyAll(): void {
    for (const t of this.tabs) {
      try {
        t.cdp.destroy()
        this.win.contentView.removeChildView(t.view)
        ;(t.view.webContents as any).destroy?.()
      } catch {}
    }
    this.tabs = []
  }
}
