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
}
