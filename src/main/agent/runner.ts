import { Executor } from '../executor'
import { DETECT_FRICTION_FN, type ExtractResult } from '../extractor'
import type { TabManager } from '../tabs'
import { getSettings } from '../settings'
import { matchKB } from '../knowledge'
import { buildStepMessage, SYSTEM_PROMPT, VISION_ADDON, LOCAL_SYSTEM_PROMPT, buildLocalPrompt } from './prompts'
import { createProvider, isVisionUnsupportedError, type ContentPart, type LlmProvider } from './llm'
import { validateLocalActions, type FastLlm } from '../fastllm'
import { ocrPageText } from '../ocr'
import type {
  AgentAction,
  AgentStatus,
  GuidanceMessage,
  Settings,
  StepRecord,
  MainEvent
} from '@shared/types'

type Broadcast = (ev: MainEvent) => void

/** 本会话内已确认不支持图片输入的模型（`baseURL|model`）：后续任务直接走纯文本，避免每步都撞一次报错 */
const visionUnsupported = new Set<string>()

/** 宽松解析模型输出的 JSON（容忍 markdown 围栏、前后杂文） */
function parseModelJson(text: string): { thought: string; actions: AgentAction[] } | null {
  let t = text.trim()
  t = t.replace(/```(?:json)?/gi, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = t.slice(start, end + 1)
  try {
    const obj = JSON.parse(slice)
    if (!obj || typeof obj !== 'object') return null
    const thought = String(obj.thought || '').slice(0, 300)
    let actions = Array.isArray(obj.actions) ? obj.actions : []
    actions = actions
      .filter((a: any) => a && typeof a.name === 'string')
      .slice(0, 5)
      .map((a: any) => ({
        name: a.name,
        index: typeof a.index === 'number' ? a.index : undefined,
        index2: typeof a.index2 === 'number' ? a.index2 : undefined,
        text: a.text != null ? String(a.text) : undefined,
        url: a.url != null ? String(a.url) : undefined,
        key: a.key != null ? String(a.key) : undefined,
        value: a.value != null ? String(a.value) : undefined,
        direction: a.direction,
        amount: typeof a.amount === 'number' ? a.amount : undefined,
        seconds: typeof a.seconds === 'number' ? a.seconds : undefined,
        result: a.result != null ? String(a.result) : undefined
      }))
    return { thought, actions }
  } catch {
    return null
  }
}

export class AgentRunner {
  private tabManager: TabManager
  private executor: Executor
  private broadcast: Broadcast
  /** 可选：OCR 增强钩子（给图片按钮补标签 / 降级读图） */
  ocrEnhancer?: (res: ExtractResult, png: Buffer | null) => Promise<ExtractResult>
  /** 可选：本地快速决策模型（混合模式；ready 前不参与） */
  fastllm?: FastLlm
  /** 上一步实际执行成功的动作批（repeat 动作重放用；已剥离 result/error 大文本） */
  private lastExecutedActions: AgentAction[] = []

  private state: AgentStatus = {
    state: 'idle',
    task: '',
    stepCount: 0,
    statusText: '空闲',
    usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
    memory: {}
  }
  private steps: StepRecord[] = []
  private lastResults: string[] = []
  /** 暂停/运行期间用户发的人工指导（下一步注入提示词；仅在模型调用成功后出队） */
  private pendingGuidance: GuidanceMessage[] = []
  private abortCtrl: AbortController | null = null
  private pauseRequested = false
  private resumeWaiters: (() => void)[] = []
  private loginHintedHosts = new Set<string>()

  constructor(tabManager: TabManager, executor: Executor, broadcast: Broadcast) {
    this.tabManager = tabManager
    this.executor = executor
    this.broadcast = broadcast
  }

  getStatus(): AgentStatus {
    return { ...this.state, memory: { ...this.state.memory }, pendingGuidance: this.pendingGuidance.length }
  }

  private setState(patch: Partial<AgentStatus>): void {
    this.state = { ...this.state, ...patch }
    // AI 工作状态 → 覆盖层淡蓝遮罩/水波纹/顶部状态条
    try {
      this.executor.overlay?.setWorking(this.state.state === 'running')
      if (patch.statusText !== undefined) this.executor.overlay?.setStatusText(patch.statusText)
    } catch {}
    this.broadcast({ channel: 'agent-status', status: this.getStatus() })
  }

  /**
   * 暂停等待：等到「继续」后被唤醒。
   * 返回 true=继续执行，false=任务已被停止。
   */
  private async waitIfPaused(): Promise<boolean> {
    if (!this.pauseRequested) return true
    this.setState({ state: this.state.state === 'captcha' ? 'captcha' : 'paused', statusText: '已暂停，等待人工操作' })
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    if (this.state.state === 'stopped') return false
    // 用户可能已在暂停期间人工操作了页面（登录/验证/点进编辑态/直接代操作），
    // 唤醒后提示模型以最新页面状态为准，不要基于旧认知继续
    this.lastResults.push(
      '系统提示: 用户刚点击了「继续」。用户可能在暂停期间人工操作过页面/浏览器，页面状态可能已改变，必须完全以本次最新元素列表为准继续任务，不要重复用户可能已完成的操作。若有用户指导消息，优先按指导执行。'
    )
    this.setState({ state: 'running', statusText: '继续执行中' })
    return true
  }

  /**
   * 循环节点：统一处理暂停等待与停止判定。
   * 暂停会中断 LLM 调用（abort 信号），恢复后重建 AbortController 继续当前步骤。
   * 返回 true=继续循环，false=任务结束。
   */
  private async checkpoint(): Promise<boolean> {
    if (this.state.state === 'stopped') return false
    if (this.pauseRequested) {
      // 等待期间被停止时 waitIfPaused 返回 false
      if (!(await this.waitIfPaused())) return false
    }
    if (this.abortCtrl?.signal.aborted) {
      this.abortCtrl = new AbortController()
      // 快速「暂停→继续」竞态：未经过 waitIfPaused 就恢复了，把状态拉回运行中
      if (this.state.state === 'paused') this.setState({ state: 'running', statusText: '继续执行中' })
    }
    return true
  }

  async startTask(task: string): Promise<void> {
    if (this.state.state === 'running' || this.state.state === 'paused') {
      throw new Error('已有任务在运行，请先停止')
    }
    const settings = getSettings()
    if (!settings.apiKey) throw new Error('请先在「设置」中配置 AI 接口（baseURL / API Key / 模型）')

    const provider = createProvider(settings)
    this.steps = []
    this.lastResults = []
    this.pendingGuidance = []
    this.lastExecutedActions = []
    this.loginHintedHosts.clear()
    this.abortCtrl = new AbortController()
    this.pauseRequested = false
    this.setState({
      state: 'running',
      task,
      stepCount: 0,
      statusText: '任务启动中',
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
      memory: {},
      result: undefined
    })
    // 异步跑循环，startTask 立即返回
    this.loop(task, provider, settings).catch((e) => {
      this.setState({ state: 'error', statusText: `任务异常: ${e?.message || e}` })
      this.broadcast({ channel: 'toast', message: `任务异常: ${e?.message || e}`, kind: 'error' })
    })
  }

  pauseTask(): void {
    if (this.state.state !== 'running') return
    this.pauseRequested = true
    // 立即中断进行中的 LLM 调用（已执行的动作已记录）
    this.abortCtrl?.abort(new Error('用户暂停'))
    this.setState({ state: 'paused', statusText: '暂停中…' })
  }

  resumeTask(): void {
    if (this.state.state !== 'paused' && this.state.state !== 'captcha') return
    const hadWaiters = this.resumeWaiters.length > 0
    this.pauseRequested = false
    const ws = this.resumeWaiters
    this.resumeWaiters = []
    ws.forEach((w) => w())
    if (!hadWaiters) {
      // 兜底：循环卡在某个不可中断的调用上（到达不了暂停检查点），
      // abort 信号把它打断后由 checkpoint 重建并继续当前步骤
      this.abortCtrl?.abort(new Error('恢复任务：中断卡住的调用'))
      this.setState({ state: 'running', statusText: '继续执行中（已强制恢复）' })
    }
  }

  stopTask(): void {
    if (this.state.state === 'idle') return
    this.pauseRequested = false
    this.abortCtrl?.abort(new Error('用户停止'))
    const ws = this.resumeWaiters
    this.resumeWaiters = []
    ws.forEach((w) => w())
    this.setState({ state: 'stopped', statusText: '已停止' })
  }

  /**
   * 人工指导：暂停/运行中用户给 AI 的留言（可带截图指路）。
   * 排队待注入：循环构造下一步提示词时优先携带；模型调用成功前不出队
   * （暂停中断重跑本步时指导不丢）。
   */
  sendGuidance(text: string, image?: string): void {
    if (this.state.state !== 'running' && this.state.state !== 'paused' && this.state.state !== 'captcha') {
      throw new Error('当前没有进行中的任务，无法发送指导')
    }
    const t = (text || '').trim().slice(0, 1000)
    if (!t && !image) throw new Error('指导内容不能为空')
    // 只收 jpeg/png dataURL，限制 4MB（渲染层已压缩，这里兜底）
    let img: string | undefined
    if (image && /^data:image\/(?:png|jpeg);base64,/.test(image) && image.length < 4 * 1024 * 1024) {
      img = image
    }
    const msg: GuidanceMessage = { ts: Date.now(), text: t, image: img }
    this.pendingGuidance.push(msg)

    // 时间线立即显示为用户气泡（指导也进 steps：历史压缩后模型仍能看到）
    const tab = this.tabManager.active()
    const stepN = this.steps.filter((s) => !s.userGuidance).length + 1
    const step = this.recordStep(
      stepN,
      t || '（截图指路）',
      [{ name: 'wait', result: img ? '用户指导（含截图）' : '用户指导' }],
      tab || { id: -1, title: '', url: '' },
      undefined,
      img
    )
    step.userGuidance = true
    this.broadcast({ channel: 'step', step })

    this.setState({
      statusText:
        this.state.state === 'running'
          ? `已收到人工指导，下一步注入（排队 ${this.pendingGuidance.length} 条）`
          : `已收到人工指导，点「继续」后生效（排队 ${this.pendingGuidance.length} 条）`
    })
  }

  /**
   * 混合模式门控：仅"上一步全成功 + 同站点 + 无页签/跳转/粘贴类大变化"时才允许本地直出。
   * 保守优先——宁可多走云端，不让本地小模型在陌生页面上冒险。
   */
  private localGateOk(extract: ExtractResult): boolean {
    const last = this.steps[this.steps.length - 1]
    if (!last || last.userGuidance) return false
    if (last.local) return true // 上一步本地直出成功且页面仍在 → 模式延续（最快路径）
    if (last.actions.some((a) => a.error)) return false
    const bigChange = last.actions.some((a) =>
      ['switch_tab', 'new_tab', 'close_tab', 'goto', 'back', 'forward', 'paste_rich', 'paste_image', 'repeat', 'drag'].includes(a.name)
    )
    if (bigChange) return false
    try {
      return new URL(last.url).host === new URL(extract.url).host
    } catch {
      return false
    }
  }

  private async loop(
    task: string,
    provider: LlmProvider,
    settings: Pick<Settings, 'maxSteps' | 'maxElements' | 'vision' | 'baseURL' | 'model' | 'aiMode'>
  ): Promise<void> {
    let consecutiveParseFail = 0
    let skipCaptchaCheckOnce = false
    // 视觉模式：设置开启且该模型未被确认"不支持图片"；任务内降级标志（模型拒图后本任务不再发图）
    const visionKey = `${settings.baseURL}|${settings.model}`
    let visionDegraded = false
    // 混合模式（本地快速决策）：失败后冷却若干步；本地推理过慢则本任务禁用
    let localCooldown = 0
    let localDisabled = false

    while (true) {
      // 暂停等待 / 停止判定（返回 false 则任务结束）
      if (!(await this.checkpoint())) return
      const signal = this.abortCtrl!.signal

      // 模型步数（人工指导不算步数预算）
      const stepN = this.steps.filter((s) => !s.userGuidance).length + 1
      if (stepN > settings.maxSteps) {
        this.setState({
          state: 'done',
          statusText: `已达到最大步数 ${settings.maxSteps}，任务结束`,
          result: `已达最大步数 ${settings.maxSteps}。如需继续，可重新发起任务。`
        })
        return
      }

      const tab = this.tabManager.active()
      if (!tab) throw new Error('没有可用页签，请新建页签后再开始任务')

      this.setState({ statusText: `第 ${stepN} 步：提取页面元素…` })

      // 1. 提取当前页签元素
      let extract: ExtractResult
      try {
        extract = await this.executor.extract(tab)
        if (this.ocrEnhancer) {
          try {
            extract = await this.ocrEnhancer(extract, null)
          } catch {}
        }
      } catch (e: any) {
        throw new Error(`页面元素提取失败: ${e?.message || e}（页面可能在加载中，稍后重试）`)
      }

      // DOM 提取稀疏时 OCR 兜底（图片型页面）
      if (extract.candidates.length < 3 && this.ocrEnhancer) {
        try {
          const ocrText = await ocrPageText(this.tabManager)
          if (ocrText) {
            this.lastResults.push(`[OCR整页识别] 页面可交互元素极少，以下是整页截图 OCR 文字:\n${ocrText.slice(0, 4000)}`)
          }
        } catch {}
      }

      // 2. 验证码 / 登录检测
      if (!skipCaptchaCheckOnce) {
        try {
          const fr = await tab.cdp.evaluate<{
            urlHit: boolean
            hitSel: string[]
            textHit: boolean
            loginHint: boolean
            url: string
          }>(DETECT_FRICTION_FN, [])
          const isCaptcha = fr.hitSel.length > 0 || fr.textHit || fr.urlHit
          if (isCaptcha) {
            skipCaptchaCheckOnce = true
            this.pauseRequested = true
            this.setState({ state: 'captcha', statusText: '检测到验证码/安全验证，已暂停等待人工处理' })
            this.tabManager.notifyCaptcha(fr.hitSel[0] || fr.url.slice(0, 60) || '页面文本特征')
            // 记录一条提示性步骤
            this.recordStep(stepN, '检测到验证码/安全验证，已自动暂停，请人工完成后点击「继续」', [
              { name: 'wait', result: '等待人工完成验证' }
            ], tab)
            continue
          }
          if (fr.loginHint) {
            let host = ''
            try {
              host = new URL(fr.url).host
            } catch {}
            if (host && !this.loginHintedHosts.has(host)) {
              this.loginHintedHosts.add(host)
              this.lastResults.push(`系统提示: 当前页面(${host})似乎需要登录。若尚未登录，请人工在浏览器中完成登录，或让模型打开登录页。`)
            }
          }
        } catch {}
      } else {
        skipCaptchaCheckOnce = false
      }

      // 3. 组装提示词并调用模型（问题经验库按当前页域名匹配注入）
      const tabsInfo = this.tabManager.infoList()
      // 视觉模式：调用模型前截一张较高质量的视口截图发给模型；截失败则本步静默走纯文本
      const visionActive = settings.vision && !visionDegraded && !visionUnsupported.has(visionKey)
      const kbTips = matchKB(tab.url).map((e) => ({ domain: e.domain, problem: e.problem, solution: e.solution }))
      // 快照当前排队指导（调用成功前不出队：暂停中断重跑本步时指导不丢）
      const guidanceCount = this.pendingGuidance.length
      const guidance = this.pendingGuidance.slice(0, guidanceCount)
      if (localCooldown > 0) localCooldown--

      // 3.5 混合模式：本地快速决策直出简单步骤（严格门控 + 契约校验；失败/不确定立即回退云端）
      let localParsed: { thought: string; actions: AgentAction[] } | null = null
      if (
        settings.aiMode === 'hybrid' &&
        !localDisabled &&
        localCooldown === 0 &&
        !visionActive && // 视觉信息本地小模型看不到
        guidance.length === 0 && // 人工指导/经验库是高优先指令，必须云端处理
        kbTips.length === 0 &&
        stepN > 1 && // 首步由云端建立任务理解
        this.fastllm?.isReady() &&
        this.localGateOk(extract)
      ) {
        try {
          const shot = await this.fastllm.decide(
            LOCAL_SYSTEM_PROMPT,
            buildLocalPrompt({
              task,
              extract,
              elementLines: this.executor.formatForPrompt(extract, Math.min(30, settings.maxElements)),
              memory: this.state.memory,
              lastResults: [...this.lastResults]
            })
          )
          if (shot) {
            const p = parseModelJson(shot)
            const err = validateLocalActions(p, extract.candidates.length)
            if (p && !err) localParsed = p
            else localCooldown = 10 // 本地决策不可靠：冷却 10 步内全走云端
          } else {
            localCooldown = 10
          }
          if (this.fastllm!.genMs > 10000) localDisabled = true // 本地推理 >10s（WASM 单线程），失去加速意义
        } catch {
          localCooldown = 10
        }
      }

      let llmOut: { text: string; usage: { inputTokens: number; outputTokens: number } }
      let visionRetryUsed = false // 带图调用失败后改用纯文本重试（模型实际没看到截图）
      let localUsed = false
      let useVision = false

      if (localParsed) {
        // ⚡ 本地直出：跳过云端调用，直接进入动作执行（token 0）
        localUsed = true
        // 上一步结果已在 buildLocalPrompt 消费，这里同样清空——
        // 否则混合模式连续命中时旧页面文本（read_content 最长 6200 字/步）无限累积，
        // 既污染本地小模型上下文，恢复云端后第一步还会把陈旧数据整包灌进提示词
        this.lastResults = []
        llmOut = {
          text: JSON.stringify({ thought: localParsed.thought, actions: localParsed.actions }),
          usage: { inputTokens: 0, outputTokens: 0 }
        }
        this.setState({ statusText: `第 ${stepN} 步：⚡本地快速决策（${Math.round(this.fastllm!.genMs)}ms，未走云端）` })
      } else {
        let visionShot: string | null = null
        if (visionActive) {
          try {
            visionShot = await tab.cdp.screenshotJpeg(70)
          } catch {}
        }
        useVision = visionActive && !!visionShot
        const elementLines = this.executor.formatForPrompt(extract, settings.maxElements, useVision)
        const userMsg = buildStepMessage({
          task,
          tabs: tabsInfo,
          activeTabId: tab.id,
          extract,
          elementLines,
          maxElements: settings.maxElements,
          memory: this.state.memory,
          steps: this.steps,
          lastResults: this.lastResults,
          guidance,
          vision: useVision,
          kbTips
        })
        this.lastResults = []
        this.setState({
          statusText: `第 ${stepN} 步：模型思考中${useVision ? '（👁视觉）' : ''}…（当前累计 ${
            this.state.usage.inputTokens + this.state.usage.outputTokens
          } tokens）`
        })

        // 视觉截图 / 带截图的指导 → 多模态消息（文本 + 图片块，页面截图在前、指导截图在后）
        const guidanceImages = guidance
          .filter((g) => g.image)
          .map((g) => ({ type: 'image' as const, dataUrl: g.image! }))
        const content: string | ContentPart[] =
          useVision || guidanceImages.length
            ? [
                { type: 'text', text: userMsg },
                ...(useVision ? [{ type: 'image' as const, dataUrl: visionShot! }] : []),
                ...guidanceImages
              ]
            : userMsg
        const systemPrompt = useVision ? SYSTEM_PROMPT + VISION_ADDON : SYSTEM_PROMPT

        try {
          llmOut = await provider.chat(systemPrompt, [{ role: 'user', content }], signal)
        } catch (e: any) {
          const hasImage = Array.isArray(content)
          // 视觉模式下模型拒图（纯文本模型遇到 image 块）：降级并重跑本步（会话内记住，后续任务不再发图）
          if (hasImage && useVision && !signal.aborted && isVisionUnsupportedError(e)) {
            visionUnsupported.add(visionKey)
            visionDegraded = true
            const ds = this.recordStep(
              stepN,
              `模型不接受图片输入，视觉模式已自动降级为元素列表模式（本会话内不再重试图片）`,
              [{ name: 'wait', result: '视觉模式降级为纯文本' }],
              tab
            )
            this.broadcast({ channel: 'step', step: ds })
            continue
          }
          // 模型不支持图片（纯文本模型遇到 image 块常直接报错）：去掉截图重试一次
          if (hasImage && !signal.aborted) {
            try {
              visionRetryUsed = true
              llmOut = await provider.chat(systemPrompt, [{ role: 'user', content: userMsg }], signal)
              if (useVision) visionDegraded = true // 保险：未命中启发式的拒图也按降级处理
              this.lastResults.push('系统提示: 当前模型不支持图片输入，截图已被忽略，请仅依据文字与元素列表执行。')
            } catch (e2: any) {
              if (signal.aborted) {
                if (!(await this.checkpoint())) return
                continue
              }
              throw new Error(`模型调用失败: ${e2?.message || e2}`)
            }
          } else if (signal.aborted) {
            // 暂停中断：等待恢复后重跑本步；停止则结束
            if (!(await this.checkpoint())) return
            continue
          } else {
            throw new Error(`模型调用失败: ${e?.message || e}`)
          }
        }
        if (signal.aborted) {
          if (!(await this.checkpoint())) return
          continue
        }
      }
      // 调用成功：已注入的指导正式出队（本地路径 guidance 恒为空，不会到这里带指导）
      if (guidanceCount > 0 && !localUsed) {
        this.pendingGuidance.splice(0, guidanceCount)
        this.setState({ statusText: `第 ${stepN} 步：模型思考中…` })
      }

      const usage = {
        inputTokens: this.state.usage.inputTokens + llmOut.usage.inputTokens,
        outputTokens: this.state.usage.outputTokens + llmOut.usage.outputTokens,
        steps: stepN
      }

      // 4. 解析模型输出
      const parsed = parseModelJson(llmOut.text)
      if (!parsed) {
        consecutiveParseFail++
        this.recordStep(
          stepN,
          '（模型输出解析失败）',
          [{ name: 'wait', result: '模型输出不是合法 JSON' }],
          tab,
          { input: llmOut.usage.inputTokens, output: llmOut.usage.outputTokens }
        )
        this.setState({ usage })
        this.lastResults.push(
          `系统提示: 你上一步的输出不是合法 JSON（原始输出前500字: ${llmOut.text.slice(0, 500)}）。请严格按格式输出 {"thought":"...","actions":[...]}`
        )
        if (consecutiveParseFail >= 3) {
          throw new Error('模型连续 3 次输出无法解析，请检查模型是否支持 JSON 输出或更换模型')
        }
        continue
      }
      consecutiveParseFail = 0

      if (!parsed.actions.length) {
        this.recordStep(stepN, parsed.thought || '（无动作）', [{ name: 'wait', result: '模型未输出动作' }], tab, {
          input: llmOut.usage.inputTokens,
          output: llmOut.usage.outputTokens
        })
        this.setState({ usage })
        this.lastResults.push('系统提示: actions 为空。你必须至少输出一个动作（或 done）。')
        continue
      }

      // 5. 执行动作批
      this.setState({ statusText: `第 ${stepN} 步：执行 ${parsed.actions.length} 个动作…`, usage })
      const executed = await this.executor.executeBatch(parsed.actions, {
        memory: this.state.memory,
        signal,
        settings: getSettings(),
        prevActions: this.lastExecutedActions
      })
      // 只认实际执行成功的 done（暂停/出错打断批次时不应误判完成）
      const doneAction = executed.find((a) => a.name === 'done' && !a.error)
      // 供 repeat 重放：剥离大文本字段，只留动作骨架
      this.lastExecutedActions = executed
        .filter((a) => a.name !== 'done')
        .map(({ result: _r, error: _e, ...rest }) => rest)

      // 收集动作结果供下一步（read_content / extract_images 等大文本）
      for (const a of executed) {
        if (a.error) this.lastResults.push(`动作 ${a.name} 出错: ${a.error}`)
        else if (
          a.result &&
          (a.name === 'read_content' ||
            a.name === 'recall' ||
            a.name === 'extract_images' ||
            a.name === 'paste_image' ||
            a.name === 'paste_rich')
        )
          this.lastResults.push(`[${a.name}] ${a.result}`)
      }

      // 6. 记录步骤（含视口截图；视觉模式标记模型确实收到了截图）
      const screenshot = await tab.cdp.screenshotJpeg()
      const step = this.recordStep(stepN, parsed.thought, executed, tab, {
        input: llmOut.usage.inputTokens,
        output: llmOut.usage.outputTokens
      }, screenshot || undefined)
      if (useVision && !visionRetryUsed) step.vision = true
      if (localUsed) step.local = true
      this.broadcast({ channel: 'step', step })

      if (doneAction) {
        this.setState({
          state: 'done',
          statusText: '任务完成',
          result: doneAction.result || doneAction.value || '任务完成',
          stepCount: this.steps.length
        })
        this.broadcast({ channel: 'toast', message: `任务完成：${(doneAction.result || '').slice(0, 80)}`, kind: 'success' })
        return
      }
    }
  }

  private recordStep(
    n: number,
    thought: string,
    actions: AgentAction[],
    tab: { id: number; title: string; url: string },
    tokens?: { input: number; output: number },
    screenshot?: string
  ): StepRecord {
    const step: StepRecord = {
      n,
      thought,
      actions,
      tabId: tab.id,
      tabTitle: tab.title,
      url: tab.url,
      title: '',
      tokens,
      screenshot,
      ts: Date.now()
    }
    this.steps.push(step)
    this.setState({ stepCount: this.steps.length })
    return step
  }
}
