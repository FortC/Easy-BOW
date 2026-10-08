import type { WebContents } from 'electron'

/**
 * 基于 Electron 内置 webContents.debugger 的 CDP 会话封装。
 * 每个页签的 webContents 独立附加；若用户打开了 DevTools 导致会话脱离，
 * 自动在 1 秒后重连。
 */
export class Cdp {
  private wc: WebContents
  private attached = false
  private destroyed = false
  /** JS 原生弹窗自动应答策略（null=不接管；仅测试运行期间由 runner 开启） */
  private dialogPolicy: 'accept' | 'dismiss' | null = null
  private dialogPageEnabled = false
  private dialogHandler: ((_e: unknown, method: string, params: any) => void) | null = null
  /** 已自动应答的弹窗记录（consumeDialogs 取走） */
  private dialogLog: string[] = []

  constructor(wc: WebContents) {
    this.wc = wc
    wc.debugger.on('detach', (_e, reason) => {
      this.attached = false
      if (!this.destroyed && String(reason).toLowerCase() !== 'target closed') {
        console.warn('[cdp] 会话脱离，1 秒后重连:', reason)
        setTimeout(() => this.attach(), 1000)
      }
    })
    this.attach()
  }

  attach(): void {
    if (this.attached || this.destroyed) return
    try {
      if (!this.wc.debugger.isAttached()) {
        this.wc.debugger.attach('1.3')
      }
      this.attached = true
    } catch (e) {
      console.error('[cdp] 附加失败:', e)
    }
  }

  destroy(): void {
    this.destroyed = true
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      /* 页签已销毁 */
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    if (!this.attached) this.attach()
    if (!this.attached) return Promise.reject(new Error('CDP 会话不可用'))
    // 超时保护：个别命令（大页截图/繁忙页面 evaluate）可能永不返回，挂死会卡住整个 Agent 循环
    return Promise.race([
      this.wc.debugger.sendCommand(method, params) as Promise<T>,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`CDP ${method} 超时(${timeoutMs}ms)`)), timeoutMs).unref?.()
      )
    ])
  }

  /** 在页面主 frame 执行函数（returnByValue），args 会被 JSON 序列化传入 */
  async evaluate<T = unknown>(fn: string, args: unknown[] = []): Promise<T> {
    const expr = `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const res = await this.send<{
      result?: { type?: string; value?: unknown }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`页面脚本错误: ${d.exception?.description || d.text}`)
    }
    const ro = res.result
    if (!ro || ro.type === 'undefined') return undefined as T
    return ro.value as T
  }

  /**
   * 在页面执行函数并返回元素引用（objectId，不走 returnByValue）——
   * 供 DOM.requestNode / DOM.setFileInputFiles 等需要 nodeId 的 CDP 命令用（文件上传）。
   */
  async evaluateRef(fn: string, args: unknown[] = []): Promise<string | null> {
    const expr = `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const res = await this.send<{ result?: { objectId?: string; type?: string } }>('Runtime.evaluate', {
      expression: expr,
      returnByValue: false
    })
    const ro = res.result
    if (!ro || ro.type === 'undefined' || !ro.objectId) return null
    return ro.objectId
  }

  /** 视口截图（jpeg dataURL；quality 越高越清晰，视觉模式发模型用高质量） */
  async screenshotJpeg(quality = 45): Promise<string | null> {
    try {
      const r = await this.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: Math.max(30, Math.min(95, Math.round(quality)))
      })
      return r.data ? `data:image/jpeg;base64,${r.data}` : null
    } catch {
      return null
    }
  }

  /** 全页 PNG 截图 base64（给 OCR 用） */
  async screenshotPng(): Promise<Buffer | null> {
    try {
      const r = await this.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png'
      })
      return r.data ? Buffer.from(r.data, 'base64') : null
    } catch {
      return null
    }
  }

  /** 浏览器级真实鼠标点击（trusted 事件，坐标为页面 CSS 像素） */
  async mouseClick(x: number, y: number): Promise<void> {
    const base = { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', base)
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
  }

  /** 真实键盘输入（走输入法通道，兼容中文与 React 受控组件） */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  /** Ctrl+A 全选当前焦点内容（用于输入前清空替换） */
  async keySelectAll(): Promise<void> {
    const base = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** 按下鼠标（拖动起点） */
  async mouseDown(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  }

  /** 无按键悬停（触发 CSS :hover / mouseenter；hover 菜单展开用） */
  async mouseHover(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  }

  /** 拖动中的移动（保持左键按下） */
  async mouseDragMove(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  }

  /** 松开鼠标（拖动终点） */
  async mouseUp(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 })
  }

  /** 真实滚轮事件 */
  async mouseWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      button: 'none'
    })
  }

  isAttached(): boolean {
    return this.attached
  }

  /**
   * JS 原生弹窗（alert/confirm/prompt/beforeunload）自动应答。
   * 仅测试模式启用（policy 非 null）：弹窗会阻塞页面 JS 与 CDP evaluate，测试流程遇
   * confirm 必挂；普通任务保持 null 完全不接管（行为与历史版本一致）。
   * beforeunload 一律 dismiss（防误导航离开页面），其余按 policy 应答。
   */
  setDialogPolicy(policy: 'accept' | 'dismiss' | null): void {
    this.dialogPolicy = policy
    if (!policy) {
      this.dialogLog = []
      return
    }
    if (!this.dialogHandler) {
      this.dialogHandler = (_e, method, params) => {
        if (method !== 'Page.javascriptDialogOpening' || !this.dialogPolicy) return
        // 注：CDP 派发输入触发的 confirm/prompt，浏览器侧上报的 messageType 可能降级为
        // 'alert'（与真实用户手势触发的上报不同），故应答逻辑不区分 alert/confirm
        const type = String(params?.messageType || 'alert')
        const msg = String(params?.message || '').slice(0, 80)
        const isBeforeUnload = type === 'beforeunload'
        const accept = isBeforeUnload ? false : this.dialogPolicy === 'accept'
        this.dialogLog.push(`[${type}${isBeforeUnload ? '/阻止离开' : accept ? '/已确认' : '/已取消'}] ${msg}`)
        this.send('Page.handleJavaScriptDialog', {
          accept,
          ...(type === 'prompt' && accept ? { promptText: String(params?.defaultPrompt || '') } : {})
        }).catch(() => {})
      }
      try {
        this.wc.debugger.on('message', this.dialogHandler)
      } catch {}
    }
    if (!this.dialogPageEnabled) {
      this.dialogPageEnabled = true
      // javascriptDialogOpening 事件需要 Page 域开启才会推送
      this.send('Page.enable').catch(() => {})
    }
  }

  /** 取走并清空已自动应答的弹窗记录（runner 批后反馈给模型/报告） */
  consumeDialogs(): string | null {
    if (!this.dialogLog.length) return null
    const out = this.dialogLog.join('; ')
    this.dialogLog = []
    return out
  }
}
