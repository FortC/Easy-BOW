import { BrowserWindow, dialog, type WebContents } from 'electron'
import { WAIT_DOM_STABLE_FN } from './domstable'

/**
 * 基于 Electron 内置 webContents.debugger 的 CDP 会话封装。
 * 每个页签的 webContents 独立附加；若用户打开了 DevTools 导致会话脱离，
 * 自动在 1 秒后重连。
 */
export class Cdp {
  /** 全局默认弹窗策略（任务/测试运行期间由 runner 设定，新建页签自动继承；null=人工应答） */
  static defaultDialogPolicy: 'accept' | 'dismiss' | null = null
  /**
   * 测试钩子：接管「人工应答」路径（自测自动化用，生产恒 null → 弹消息框给人工）。
   * 返回 0=确定/离开，其余=取消/停留。
   */
  static humanDialogResponder: ((type: string, msg: string) => Promise<number>) | null = null
  private wc: WebContents
  private attached = false
  private destroyed = false
  /** 附加失败后的重试计时器（DevTools 占用等场景：attach 成功后清空） */
  private attachRetryTimer: ReturnType<typeof setTimeout> | null = null
  /** JS 原生弹窗自动应答策略（null=不接管） */
  private dialogPolicy: 'accept' | 'dismiss' | null = null
  /** 人工应答消息框是否挂起（防重入：一次只弹一个，未决期间新弹窗自动取消应答） */
  private humanDialogPending = false
  private dialogPageEnabled = false
  private dialogHandler: ((_e: unknown, method: string, params: any) => void) | null = null
  /** 已自动应答的弹窗记录（consumeDialogs 取走） */
  private dialogLog: string[] = []
  /** R1-A2：navigator.webdriver 隐藏脚本是否已注入（每个页面加载前执行） */
  private stealthApplied = false
  /** R2：上次鼠标位置（贝塞尔轨迹起点；初始假定视口中心附近） */
  private lastMouse = { x: 400, y: 300 }

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
    // 弹窗接管常开（策略只决定谁应答）：任务/测试运行期自动应答，
    // 空闲/人工接管期弹给人工决定——保证永远没有悬空的原生弹窗阻塞页面 JS
    this.ensureDialogIntercept()
    // R1-A2：隐藏 navigator.webdriver（与 UA 一致性配套，加载前注入）
    this.applyStealthScript()
    // 运行中的任务/测试新开页签时继承全局弹窗策略
    if (Cdp.defaultDialogPolicy) this.setDialogPolicy(Cdp.defaultDialogPolicy)
  }

  attach(): void {
    if (this.attached || this.destroyed) return
    try {
      if (!this.wc.debugger.isAttached()) {
        this.wc.debugger.attach('1.3')
      }
      this.attached = true
      // 重连后各域回到禁用状态（detach 常见于用户打开 DevTools）：重新开启已启用的域，
      // 否则弹窗接管/网络捕获静默失效——表现为 confirm 退回原生弹框、无人应答、任务挂死
      this.rearmDomains()
    } catch (e) {
      console.error('[cdp] 附加失败:', e)
      // 附加失败（常见：DevTools 占用 debugger / 会话抖动）：定时重试直到成功——
      // 放弃重试 = 弹窗接管永久失效，confirm 退回原生弹框无人应答
      if (!this.destroyed && !this.attachRetryTimer) {
        this.attachRetryTimer = setTimeout(() => {
          this.attachRetryTimer = null
          this.attach()
        }, 3000)
        this.attachRetryTimer.unref?.()
      }
    }
  }

  /** 重连/附加成功后重新开启已启用的域 */
  private rearmDomains(): void {
    if (this.dialogPageEnabled) this.send('Page.enable').catch(() => {})
    if (this.netCapture || this.netQuietWatch) this.send('Network.enable').catch(() => {})
    if (this.stealthApplied) this.applyStealthScript()
  }

  /**
   * R1-A2 反风控一致性：每个页面加载前把 navigator.webdriver 置为 undefined。
   * 只做这一件事——UA 用真实 Chromium 版本（tabs.ts）、其余 navigator 属性保持系统真实值；
   * 过度伪装会制造值间矛盾，比不伪装更可疑（方案 8.1-A3 一致性原则）。
   */
  applyStealthScript(): void {
    this.stealthApplied = true
    this.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        'Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });'
    }).catch(() => {})
  }

  destroy(): void {
    this.destroyed = true
    if (this.attachRetryTimer) {
      clearTimeout(this.attachRetryTimer)
      this.attachRetryTimer = null
    }
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

  /** 视口截图（jpeg dataURL；quality 越高越清晰，视觉模式发模型用高质量）。
   *  截图走 60s 超时：大页/繁忙渲染进程下 20s 会虚假超时（CDP 命令本身无法取消，只能等） */
  /**
   * Page.captureScreenshot 通用通道：窗口被遮挡/合成未就绪时会瞬时返回空或抛错，
   * 短暂重试一次再放弃（视觉截图与 OCR 兜底共用）。
   * 截图走 60s 超时：大页/繁忙渲染进程下默认 20s 会虚假超时（CDP 命令本身无法取消）。
   */
  private async captureScreenshot(params: Record<string, unknown>): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.send<{ data: string }>('Page.captureScreenshot', params, 60000)
        if (r.data) return r.data
      } catch {
        // 落到下面的重试/放弃
      }
      if (attempt === 0) await new Promise((res) => setTimeout(res, 250))
    }
    return null
  }

  /** 视口截图（jpeg dataURL；quality 越高越清晰，视觉模式发模型用高质量；scale<1 出缩略图） */
  async screenshotJpeg(quality = 45, scale = 1): Promise<string | null> {
    const q = Math.max(30, Math.min(95, Math.round(quality)))
    if (scale >= 1) {
      const data = await this.captureScreenshot({ format: 'jpeg', quality: q })
      return data ? `data:image/jpeg;base64,${data}` : null
    }
    // W2 缩略图：clip.scale 输出降采样图（时间线缩略图省编码/传输/内存）
    try {
      const m = await this.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
        'Page.getLayoutMetrics',
        {},
        5000
      )
      const vp = m?.cssVisualViewport
      if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
        const data = await this.captureScreenshot({
          format: 'jpeg',
          quality: q,
          clip: { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight, scale },
          captureBeyondViewport: false
        })
        if (data) return `data:image/jpeg;base64,${data}`
      }
    } catch {
      /* 降采样失败回退全尺寸 */
    }
    const data = await this.captureScreenshot({ format: 'jpeg', quality: q })
    return data ? `data:image/jpeg;base64,${data}` : null
  }

  /** 全页 PNG 截图 base64（给 OCR 用） */
  async screenshotPng(): Promise<Buffer | null> {
    const data = await this.captureScreenshot({ format: 'png' })
    return data ? Buffer.from(data, 'base64') : null
  }

  /** 浏览器级真实鼠标点击（trusted 事件，坐标为页面 CSS 像素） */
  async mouseClick(x: number, y: number): Promise<void> {
    const base = { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', base)
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    this.lastMouse = { x, y }
  }

  /** 真实键盘输入（走输入法通道，兼容中文与 React 受控组件） */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  /**
   * R2 拟人化键入：按字符间隔逐个输入，偶发"思考"停顿。
   * 长文本（>50 字）自动降级为整段 insertText（避免过慢）；opts.fast 强制整段。
   * 注意：需输入框已聚焦（executor 先点击聚焦后调用）。
   */
  async insertTextHuman(text: string, opts?: { fast?: boolean }): Promise<void> {
    if (opts?.fast || !text || text.length > 50) return this.insertText(text)
    for (let i = 0; i < text.length; i++) {
      await this.insertText(text[i])
      // 基础间隔 60-140ms；每 8-15 字符一次思考停顿 300-700ms
      const thinkPause = i > 0 && i % (8 + Math.floor(Math.random() * 8)) === 0
      const pause = thinkPause ? 300 + Math.random() * 400 : 60 + Math.random() * 80
      await new Promise((r) => setTimeout(r, pause))
    }
  }

  /**
   * R2 贝塞尔曲线鼠标移动：起点 → 随机偏移的控制点 → 终点，
   * 缓动（起步慢、中段快、末端慢）。移动后不点击（点击由 mouseClick 完成）。
   */
  async moveHumanTo(x: number, y: number): Promise<void> {
    const from = this.lastMouse
    const to = { x: x + (Math.random() * 4 - 2), y: y + (Math.random() * 4 - 2) }
    // 距离很近直接一步（避免原地抖动刷事件）
    if (Math.hypot(to.x - from.x, to.y - from.y) < 6) return
    const steps = 10 + Math.floor(Math.random() * 8)
    const cx = (from.x + to.x) / 2 + (Math.random() * 120 - 60)
    const cy = (from.y + to.y) / 2 + (Math.random() * 120 - 60)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const nx = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x
      const ny = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(nx),
        y: Math.round(ny),
        button: 'none',
        buttons: 0
      })
      const ease = Math.sin(Math.PI * t) * 0.6 + 0.4
      await new Promise((r) => setTimeout(r, (4 + Math.random() * 12) / ease))
    }
    this.lastMouse = to
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

  /**
   * R2 拟人滚动：easeOutCubic 缓入缓出 + 每步随机抖动。
   * 末端轻微"回弹"由调用方补一个反向小滚轮实现（executor scroll 动作）。
   */
  async scrollHuman(x: number, y: number, dy: number): Promise<void> {
    const steps = 8 + Math.floor(Math.random() * 5)
    let done = 0
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps
      const eased = 1 - Math.pow(1 - t, 3)
      const target = Math.round((dy * eased) / steps * (1 + (Math.random() * 0.4 - 0.2)))
      const delta = target - Math.round((dy * (i === 0 ? 0 : (1 - Math.pow(1 - i / steps, 3)))) / steps)
      done += delta
      await this.mouseWheel(x, y, 0, delta)
      await new Promise((r) => setTimeout(r, 16 + Math.random() * 32))
    }
    // 补齐舍入残差，保证总位移≈dy
    const rest = dy - done
    if (Math.abs(rest) >= 1) await this.mouseWheel(x, y, 0, rest)
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300)) // 滚完停顿"看一眼"
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
    this.lastMouse = { x, y }
  }

  /** 无按键悬停（触发 CSS :hover / mouseenter；hover 菜单展开用） */
  async mouseHover(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    this.lastMouse = { x, y }
  }

  /** 拖动中的移动（保持左键按下） */
  async mouseDragMove(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    this.lastMouse = { x, y }
  }

  /** 松开鼠标（拖动终点） */
  async mouseUp(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 })
    this.lastMouse = { x, y }
  }

  isAttached(): boolean {
    return this.attached
  }

  /**
   * JS 原生弹窗（alert/confirm/prompt/beforeunload）接管策略。
   * 接管本体常开（ensureDialogIntercept），policy 只决定谁应答：
   * - accept/dismiss（任务/测试运行期）：自动应答并记入 dialogLog（批后反馈给模型/报告）
   * - null（空闲/人工接管期）：弹「EasyBow 页面确认」消息框给人工点「确定/取消」，
   *   由人工决定——不留任何悬空弹窗阻塞页面 JS（原生弹窗会阻塞渲染进程，任务一跑就挂）
   * beforeunload 运行期一律阻止离开（防误导航丢任务现场）；人工期问「离开/停留」。
   */
  setDialogPolicy(policy: 'accept' | 'dismiss' | null): void {
    this.dialogPolicy = policy
    if (!policy) this.dialogLog = []
    this.ensureDialogIntercept()
  }

  /** 注册弹窗事件监听并开启 Page 域（幂等；重连后由 rearmDomains 重新下发） */
  private ensureDialogIntercept(): void {
    if (!this.dialogHandler) {
      this.dialogHandler = (_e, method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return
        // 注：CDP 派发输入触发的 confirm/prompt，浏览器侧上报的 messageType 可能降级为
        // 'alert'（与真实用户手势触发的上报不同），故应答逻辑不区分 alert/confirm
        const type = String(params?.messageType || 'alert')
        const msg = String(params?.message || '')
        const isBeforeUnload = type === 'beforeunload'
        const answer = (accept: boolean, note: string) => {
          this.dialogLog.push(`[${type}${note}] ${msg.slice(0, 80)}`)
          // 应答失败必须重试并落日志：静默吞掉的失败会让页面 JS 永久阻塞
          // （用户表现：确认框点了没反应/页面卡死）
          const send = (attempt: number): void => {
            this.send('Page.handleJavaScriptDialog', {
              accept,
              ...(type === 'prompt' && accept ? { promptText: String(params?.defaultPrompt || '') } : {})
            }).catch((e) => {
              if (attempt < 2) {
                setTimeout(() => send(attempt + 1), 300)
                return
              }
              console.error(`[cdp] 弹窗应答失败（页面脚本可能被阻塞，重开页签可解）: ${String(e?.message || e)}`)
            })
          }
          send(0)
        }
        if (this.dialogPolicy) {
          if (isBeforeUnload) return answer(false, '/阻止离开')
          const accept = this.dialogPolicy === 'accept'
          return answer(accept, accept ? '/已确认' : '/已取消')
        }
        // 空闲/人工接管期：弹给人工决定（消息框异步显示，页面弹窗先被 CDP 接管不阻塞整应用）
        const humanNote = (r: number) =>
          isBeforeUnload ? (r === 0 ? '/人工离开' : '/人工停留') : r === 0 ? '/人工确认' : '/人工取消'
        if (Cdp.humanDialogResponder) {
          Cdp.humanDialogResponder(type, msg)
            .then((r) => answer(r === 0, humanNote(r)))
            .catch(() => answer(false, '/应答失败按取消'))
          return
        }
        // 防重入：人工弹窗一次只挂一个（连点两个 confirm 会叠两个消息框，旧框的应答会错乱）；
        // 未决期间新弹窗按取消自动应答
        if (this.humanDialogPending) {
          answer(false, '/自动取消（有人工弹窗未决）')
          return
        }
        this.humanDialogPending = true
        const buttons = isBeforeUnload ? ['离开', '停留'] : type === 'alert' ? ['确定'] : ['确定', '取消']
        let parent: BrowserWindow | undefined
        try {
          parent = BrowserWindow.fromWebContents(this.wc) || undefined
        } catch {}
        const boxOpts = {
          type: 'question' as const,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
          title: 'EasyBow 页面确认',
          message: (isBeforeUnload ? '页面想在离开前确认' : msg.slice(0, 300)) || '页面请求确认',
          detail: isBeforeUnload
            ? msg.slice(0, 300) || '（页面注册了离开确认）'
            : type === 'prompt'
              ? '（提示框将以默认内容应答）'
              : undefined
        }
        const box = parent ? dialog.showMessageBox(parent, boxOpts) : dialog.showMessageBox(boxOpts)
        box
          .then(({ response }) => answer(response === 0, humanNote(response)))
          .catch(() => answer(false, '/应答失败按取消'))
          .finally(() => {
            this.humanDialogPending = false
          })
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

  /**
   * 强制应答可能遗留的未应答弹窗（无弹窗时静默失败）。
   * 暂停恢复接管时调用：人工接管期间的弹窗由人工决定，若人工留了个未关的，
   * 页面 JS 与 CDP evaluate 会被永久阻塞，任务恢复后直接挂死。
   */
  clearPendingDialog(accept = true): void {
    this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {})
  }

  // —————— 网络捕获（测试断言） + in-flight 生命周期跟踪（W1 智能等待 / wait_for 未来监听） ——————

  private netCapture = false
  private netHandler: ((_e: unknown, method: string, params: any) => void) | null = null
  private netLog: Array<{ requestId: string; url: string; status: number; type: string; ts: number }> = []
  /** W1 轻量网络活动跟踪：只记时间戳（环形最近 50 条），供「网络静默」判定 */
  private netActivity: number[] = []
  /** in-flight 生命周期（P0-3）：只跟白名单 XHR/Fetch/Document——requestWillBeSent 记账、
   *  loadingFinished/Failed 销账；网络 idle 判定以「白名单在途 = 0」为准（图片/静态资源不卡静默） */
  private netInflight = new Map<
    string,
    { url: string; method: string; type: string; ts: number; status?: number; finished?: boolean }
  >()
  /** wait_for network 未来监听（P0-3）：注册后「未来」出现的匹配请求才算等到 */
  private netWaiters: Array<{
    urlPart: string
    method?: string
    since: number
    resolve: (r: { status: number; url: string; stale: boolean } | null) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  /**
   * 网络捕获开关（测试模式网络级断言用）：收集 XHR/Fetch/Document 响应（URL+状态码），
   * 响应体按需经 Network.getResponseBody 拉取（缓冲被浏览器回收后会失败，断言如实报错）。
   */
  setNetworkCapture(on: boolean): void {
    if (on === this.netCapture) return
    this.netCapture = on
    if (on) {
      this.netLog = []
      this.ensureNetTracking()
    } else {
      // 日志保留供断言读取；下次开启时清空。网络活动跟踪不随之关闭（W1 智能等待要用）
      if (!this.netQuietWatch) this.send('Network.disable', {}).catch(() => {})
    }
  }

  /** W1：网络活动跟踪开启标志（智能等待的「网络静默」信号源） */
  private netQuietWatch = false

  /**
   * W1 智能等待的网络跟踪：只记「有请求在飞/刚结束」的时间戳与 in-flight 记账，
   * 开销可忽略（普通任务常开）。CDP 重连后由 rearmDomains 重新下发。
   */
  setNetQuietWatch(on: boolean): void {
    this.netQuietWatch = on
    if (on) this.ensureNetTracking()
    else if (!this.netCapture) this.send('Network.disable', {}).catch(() => {})
  }

  /** 注册网络事件监听并开启 Network 域（幂等） */
  private ensureNetTracking(): void {
    if (!this.netHandler) {
      this.netHandler = (_e, method, params) => {
        const touch = () => {
          this.netActivity.push(Date.now())
          if (this.netActivity.length > 50) this.netActivity.splice(0, this.netActivity.length - 50)
        }
        if (method === 'Network.requestWillBeSent') {
          const t = String(params?.type || '')
          // in-flight 只记白名单（XHR/Fetch/Document）：图片/样式/字体长连接不卡「网络静默」
          if (['XHR', 'Fetch', 'Document'].includes(t)) {
            this.netInflight.set(String(params.requestId), {
              url: String(params?.request?.url || ''),
              method: String(params?.request?.method || 'GET'),
              type: t,
              ts: Date.now()
            })
            touch()
          }
          return
        }
        if (method === 'Network.responseReceived') {
          const rec = this.netInflight.get(String(params?.requestId))
          if (rec) rec.status = Number(params?.response?.status || 0)
          if (!this.netCapture) return
          const r = params?.response
          if (!r) return
          const t = String(params?.type || r.type || '')
          // 只记接口/文档请求，静态资源噪声不入列
          if (t && !['XHR', 'Fetch', 'Document'].includes(t)) return
          this.netLog.push({
            requestId: String(params.requestId),
            url: String(r.url || ''),
            status: Number(r.status || 0),
            type: t,
            ts: Date.now()
          })
          if (this.netLog.length > 200) this.netLog.splice(0, this.netLog.length - 200)
          return
        }
        if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          const rec = this.netInflight.get(String(params?.requestId))
          if (rec) {
            if (method === 'Network.loadingFailed') rec.status = rec.status ?? 0
            this.netInflight.delete(String(params?.requestId))
            // wait_for 未来监听：请求「完结」时结账（P0-3：看 loadingFinished 且判 status）
            this.settleNetWaiters(rec)
          }
          touch()
          return
        }
      }
      try {
        this.wc.debugger.on('message', this.netHandler)
      } catch {}
    }
    this.send('Network.enable', {}).catch(() => {})
  }

  /** wait_for 命中判定：URL 片段 + 可选 method（future 请求、已完成） */
  private settleNetWaiters(rec: {
    url: string
    method: string
    ts: number
    status?: number
    type: string
  }): void {
    if (!this.netWaiters.length) return
    const keep: typeof this.netWaiters = []
    for (const w of this.netWaiters) {
      if (rec.ts < w.since) {
        keep.push(w)
        continue
      }
      const methodOk = !w.method || w.method.toUpperCase() === rec.method.toUpperCase()
      if (methodOk && rec.url.includes(w.urlPart)) {
        clearTimeout(w.timer)
        w.resolve({ status: rec.status ?? 0, url: rec.url, stale: false })
      } else {
        keep.push(w)
      }
    }
    this.netWaiters = keep
  }

  /**
   * wait_for network 未来监听模式（P0-3）：调用时注册 URL 匹配器，等待**未来**出现的
   * 匹配请求完结（loadingFinished/Failed）并返回其 status——4xx/5xx 由调用方判该步失败。
   * 超时未出现 → 自动转「查最近 N 条」兜底（stale:true 如实标注兜底来源）；都没有 → null。
   */
  async waitForResponse(
    match: { urlPart: string; method?: string },
    timeoutMs = 8000
  ): Promise<{ status: number; url: string; stale: boolean } | null> {
    this.ensureNetTracking()
    const since = Date.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.netWaiters = this.netWaiters.filter((w) => w.resolve !== done)
        // 超时兜底：查最近 N 条历史（请求可能在注册前就发出/完结），如实标 stale
        const hit = [...this.netLog].reverse().find((e) => e.url.includes(match.urlPart))
        resolve(hit ? { status: hit.status, url: hit.url, stale: true } : null)
      }, timeoutMs)
      const done = (r: { status: number; url: string; stale: boolean } | null) => {
        clearTimeout(timer)
        resolve(r)
      }
      this.netWaiters.push({ urlPart: match.urlPart, method: match.method, since, resolve: done, timer })
    })
  }

  /**
   * W1 网络静默等待：等「白名单无在途请求 + quietMs 内无网络活动」或超时。
   * 长轮询/轮询页面（永远有在途请求）自然走满 timeout，与 networkidle 误用不同——
   * 这里只做「多等一会儿」的加速器，超时不判失败。
   */
  async waitNetworkQuiet(quietMs = 300, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const last = this.netActivity.length ? this.netActivity[this.netActivity.length - 1] : 0
      if (this.netInflight.size === 0 && Date.now() - last >= quietMs) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  /** W1 最近一次网络活动距今毫秒数（无活动 = Infinity） */
  netQuietMs(): number {
    const last = this.netActivity.length ? this.netActivity[this.netActivity.length - 1] : 0
    return last ? Date.now() - last : Infinity
  }

  /** W1 在途请求数（白名单）：提交后核验与等待策略用 */
  netInflightCount(): number {
    return this.netInflight.size
  }

  /**
   * 提交类点击后监听「新标签页」（P0-3：预览/支付常见 window.open）：
   * timeout 内 opener 打开了新窗口/页签 → true（调用方改为等新页 settle）。
   */
  awaitNewWindow(timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (v: boolean) => {
        if (done) return
        done = true
        try {
          this.wc.removeListener('did-create-window', onWin)
        } catch {}
        clearTimeout(timer)
        resolve(v)
      }
      const onWin = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      try {
        this.wc.on('did-create-window', onWin)
      } catch {
        finish(false)
      }
    })
  }

  getNetworkLog(): Array<{ requestId: string; url: string; status: number; type: string; ts: number }> {
    return this.netLog.slice(-200)
  }

  /** 按 URL 片段找最近一次匹配的响应（状态 + 尽力拉取响应体） */
  async findResponseBody(urlPart: string): Promise<{ status: number; url: string; body?: string } | null> {
    const hit = [...this.netLog].reverse().find((e) => e.url.includes(urlPart))
    if (!hit) return null
    let body: string | undefined
    try {
      const r = await this.send<{ body?: string }>('Network.getResponseBody', { requestId: hit.requestId })
      body = r?.body
    } catch {
      /* 响应缓冲已被回收（加载了较多后续请求）——状态码断言仍可用 */
    }
    return { status: hit.status, url: hit.url, body }
  }

  // —————— W1 DOM 稳定等待（替代固定 sleep 的核心信号） ——————

  /**
   * 等 DOM「结构性变动」静默：探针按统一 mutation 分类表（domstable.ts，W1/W10 共用）
   * 判定——childList/characterData 结构增删与语义属性（aria-* 、disabled、checked 等）计入，
   * style/纯动画 class/轮播广告容器/自注入句柄忽略；覆盖穿透的每个 shadow root。
   * 返回 true=已静默；false=吃满 timeoutMs 仍未静默（动画页/轮询页，调用方走熔断回退）。
   */
  async waitDomStable(quietMs = 250, timeoutMs = 8000): Promise<boolean> {
    try {
      const quiet = await this.send<boolean>(
        'Runtime.evaluate',
        {
          expression: `(${WAIT_DOM_STABLE_FN})(${Math.round(quietMs)},${Math.round(timeoutMs)})`,
          awaitPromise: true,
          returnByValue: true
        },
        timeoutMs + 5000
      ).then((r: any) => (typeof r === 'boolean' ? r : !!r?.result?.value))
      return quiet
    } catch {
      return true // 探针失败按静默处理（调用方有超时上限，不卡死）
    }
  }
}
