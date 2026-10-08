import { Executor } from '../executor'
import { DETECT_FRICTION_FN, type ExtractResult } from '../extractor'
import { Cdp } from '../cdp'
import type { TabManager } from '../tabs'
import { getSettings } from '../settings'
import { matchKB } from '../knowledge'
import {
  buildStepMessage,
  SYSTEM_PROMPT,
  VISION_ADDON,
  VISION_FALLBACK_ADDON,
  TEST_MODE_ADDON,
  LOCAL_SYSTEM_PROMPT,
  buildLocalPrompt,
  type TestScriptContext
} from './prompts'
import { createProvider, isVisionUnsupportedError, type ContentPart, type LlmProvider } from './llm'
import { validateLocalActions, type FastLlm } from '../fastllm'
import { ocrPageText } from '../ocr'
import { parseTestCase } from '../testcase/parser'
import { isLoginStep, pickWarmupUrl, probeLoginState } from './loginState'
import { writeTestReport } from '../testcase/report'
import { updateCaseRunStat } from '../testcase/store'
import type {
  AgentAction,
  AgentStatus,
  GuidanceMessage,
  Settings,
  StepRecord,
  MainEvent,
  TestCase,
  TestAssertion,
  TestGroup,
  TestRunStatus,
  TestStepResult
} from '@shared/types'

type Broadcast = (ev: MainEvent) => void

/** 本会话内已确认不支持图片输入的模型（`baseURL|model`）：后续任务直接走纯文本，避免每步都撞一次报错 */
const visionUnsupported = new Set<string>()

/** 测试模式内部执行上下文（仅 startTestRun 期间存在；loop 的所有测试分支以它为门卫） */
interface TestExecCtx {
  /** 所属运行代号（旧循环的收尾不得污染新运行） */
  epoch: number
  tc: TestCase
  /** 当前测试步骤（0-based） */
  stepIdx: number
  failFast: boolean
  /** 生产保护环境：提交类点击需人工确认（透传给 executor） */
  protectedSubmit: boolean
  /** 智能填充前弹人工预览确认 */
  fillPreview: boolean
  envName?: string
  /** 来源用例库条目（结束回写运行统计；直接运行/重跑无） */
  caseId?: number
  /** 当前测试步骤已消耗的模型步数（预算保护用） */
  perStepModelSteps: number
  /** 登录态复用：启动/每步探测，已登录时跳过登录类步骤 */
  loginReuse: boolean
  /** true=已登录 / false=需要登录 / null=未知（未知时保守不跳过） */
  loggedIn: boolean | null
  /** 登录态失效提示是否已注入过（同一轮只提示一次，避免刷屏） */
  loginWarned: boolean
  /** 探测摘要（日志/报告用） */
  loginDetail?: string
}

/** 断言 → expect 动作（提示词里展示给模型的确切 JSON） */
function assertionToAction(asrt: TestAssertion): AgentAction {
  return {
    name: 'expect',
    kind: asrt.kind === 'ai' ? 'text_visible' : asrt.kind,
    value: asrt.value,
    selector: asrt.selector,
    urlPart: asrt.urlPart,
    negate: asrt.negate
  }
}

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
        // 测试模式动作字段（普通任务提示词不引导输出这些，缺省为 undefined，零影响）
        kind: typeof a.kind === 'string' ? a.kind : undefined,
        selector: a.selector != null ? String(a.selector) : undefined,
        urlPart: a.urlPart != null ? String(a.urlPart) : undefined,
        negate: a.negate === true ? true : undefined,
        data: a.data && typeof a.data === 'object' && !Array.isArray(a.data) ? a.data : undefined,
        onlyRequired: a.onlyRequired === true ? true : undefined,
        path: a.path != null ? String(a.path) : undefined,
        result: a.result != null ? String(a.result) : undefined,
        // 视觉兜底：click_xy 的归一化坐标（0~1000）
        x: typeof a.x === 'number' ? a.x : undefined,
        y: typeof a.y === 'number' ? a.y : undefined
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
  /** 测试模式上下文（普通任务恒为 null——loop 内所有测试分支以它为门卫，普通路径不变） */
  private testCtx: TestExecCtx | null = null
  /** 最近一次测试运行的状态（结束后保留供 UI 查询，直到下次运行） */
  private testRun: TestRunStatus | null = null
  /** 测试模式跨步骤软断言收集（提交后校验错误提示；executor 推入，步骤判定时消费） */
  private testSoftErrors: string[] = []
  /** 数据驱动多组：收集模式（单组 run 不写报告，由合并器统一写） */
  private testCollectMode = false
  private testGroupResults: Array<{ name: string; run: TestRunStatus; shots: Map<number, string> }> = []
  /** 单组 run 完成回调（execTestSequence 顺序执行用；带 epoch 防止旧循环提前兑现新运行的 Promise） */
  private testDoneResolve: { epoch: number; resolve: (run: TestRunStatus) => void } | null = null
  /**
   * 运行代号：每次启动任务/测试前递增。
   * 旧循环若卡在不可中断的调用里（CDP/模型）还没退出，新运行启动后它的 epoch 即失配 ——
   * checkpoint 立即返回 false 退出，且它的 finally 不得收尾新运行（旧 bug：旧循环把新 run 提前标记结束，
   * 表现为「点了运行不执行 / 一直显示执行中」）。
   */
  private epoch = 0
  /** 当前进行中的主循环（供退出清理与重启动抢占用） */
  private loopActive: Promise<void> | null = null
  /** 视觉兜底：剩余强制带截图的步数（元素定位连续失败时点亮，倒数清零后回到常规模式） */
  private visionFallbackLeft = 0
  /** 连续定位失败次数（动作报「元素已失效/不可见」或页面无候选元素） */
  private locateFailStreak = 0

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
   * 新运行启动前的统一抢占：让旧循环失效并等它退出（最多 1.5s）。
   * 返回本次运行的代号；旧循环凭它自我识别为「已被取代」，不得再触碰共享状态。
   */
  private async beginRun(): Promise<number> {
    const stale = this.loopActive
    if (stale) {
      // 先把旧循环判死：abort 在途调用 + epoch 递增（它的 checkpoint 会立即返回 false）
      this.epoch++
      try {
        this.abortCtrl?.abort(new Error('新的运行已启动，旧循环作废'))
      } catch {}
      const ws = this.resumeWaiters
      this.resumeWaiters = []
      ws.forEach((w) => w())
      await Promise.race([stale.catch(() => undefined), new Promise((r) => setTimeout(r, 1500))])
    }
    this.epoch++
    return this.epoch
  }

  /**
   * 循环节点：统一处理暂停等待与停止判定。
   * 暂停会中断 LLM 调用（abort 信号），恢复后重建 AbortController 继续当前步骤。
   * 返回 true=继续循环，false=任务结束。
   */
  private async checkpoint(epoch?: number): Promise<boolean> {
    if (epoch != null && epoch !== this.epoch) return false // 已被新运行取代：立即退场
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
    const epoch = await this.beginRun()

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
    // 原生弹窗（confirm/alert）自动应答：弹窗会阻塞页面 JS 与 CDP evaluate（任务挂死），
    // 应答文案进「上一步结果」让模型知情可纠正；beforeunload 一律阻止离开
    Cdp.defaultDialogPolicy = 'accept'
    for (const t of this.tabManager.all()) t.cdp.setDialogPolicy('accept')
    const p = this.loop(task, provider, settings, epoch)
      .catch((e) => {
        if (epoch !== this.epoch) return // 已被新运行取代：异常归旧循环，不影响当前状态
        this.setState({ state: 'error', statusText: `任务异常: ${e?.message || e}` })
        this.broadcast({ channel: 'toast', message: `任务异常: ${e?.message || e}`, kind: 'error' })
      })
      .finally(() => {
        if (this.loopActive === p) this.loopActive = null
        // 任务结束解除接管（测试运行有自己的脚本级策略，不经此路径）
        if (!this.testCtx) {
          Cdp.defaultDialogPolicy = null
          for (const t of this.tabManager.all()) {
            try {
              t.cdp.setDialogPolicy(null)
            } catch {}
          }
        }
      })
    this.loopActive = p
  }

  // ———————————————— 测试模式（feature/browser-test）————————————————

  /** 强制重置卡住的测试状态（UI 看门狗 / 用户手动兜底）：把 running 判死为 stopped */
  resetTestRun(reason = '状态已重置（上次运行未正常收尾）'): TestRunStatus | null {
    const run = this.testRun
    if (run && run.state === 'running') {
      for (const s of run.steps) {
        if (s.status === 'running' || s.status === 'pending') {
          s.status = 'skipped'
          if (!s.error) s.error = reason
        }
      }
      run.state = 'stopped'
      run.endedAt = Date.now()
      run.failed = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').length
      run.error = reason
    }
    // 顺带把 Agent 状态机从「卡住的-running」拉回可启动状态
    if (this.state.state === 'running' || this.state.state === 'paused' || this.state.state === 'captcha') {
      this.pauseRequested = false
      try {
        this.abortCtrl?.abort(new Error(reason))
      } catch {}
      const ws = this.resumeWaiters
      this.resumeWaiters = []
      ws.forEach((w) => w())
    }
    this.testCtx = null
    this.testDoneResolve = null
    this.broadcastTestRun()
    return this.getTestRunStatus()
  }

  /** 应用退出：终止在途运行并释放（不广播 UI 已销毁时的事件由 sendEvent 兜底） */
  dispose(): void {
    this.epoch++
    this.pauseRequested = false
    try {
      this.abortCtrl?.abort(new Error('应用退出'))
    } catch {}
    const ws = this.resumeWaiters
    this.resumeWaiters = []
    ws.forEach((w) => w())
    this.testCtx = null
    this.testDoneResolve = null
    try {
      Cdp.defaultDialogPolicy = null
      for (const t of this.tabManager.all()) t.cdp.setDialogPolicy(null)
    } catch {}
  }

  getTestRunStatus(): TestRunStatus | null {
    return this.testRun ? (JSON.parse(JSON.stringify(this.testRun)) as TestRunStatus) : null
  }

  private broadcastTestRun(): void {
    if (this.testRun) this.broadcast({ channel: 'test-run', run: this.getTestRunStatus()! })
  }

  /**
   * 启动测试运行：解析用例 MD → 数据组（缺省单组）→ 逐组在独立测试页签执行 → 报告。
   * 入口只做同步校验（快速把错误抛给 UI），执行序列异步跑。
   */
  async startTestRun(
    md: string,
    opts: {
      failFast: boolean
      fillPreview?: boolean
      loginReuse?: boolean
      caseId?: number
      env?: { name: string; baseUrl: string; protected: boolean }
    }
  ): Promise<void> {
    if (this.state.state === 'running' || this.state.state === 'paused') {
      throw new Error('已有任务在运行，请先停止')
    }
    const settings = getSettings()
    if (!settings.apiKey) throw new Error('请先在「设置」中配置 AI 接口（baseURL / API Key / 模型）')
    const parsed = parseTestCase(md)
    if (!parsed.ok || !parsed.tc) throw new Error(`测试用例解析失败: ${parsed.error}`)
    const tc = parsed.tc
    const epoch = await this.beginRun()
    // 数据驱动多组：数据区含 ### 组名 小节时逐组跑同一脚本；缺省单组（向后兼容）
    const groups: TestGroup[] = tc.groups?.length ? tc.groups : [{ name: '', vars: tc.vars }]
    void this.execTestSequence(tc, groups, settings, opts, epoch).catch((e) => {
      if (epoch !== this.epoch) return
      this.setState({ state: 'error', statusText: `测试异常: ${e?.message || e}` })
      this.broadcast({ channel: 'toast', message: `测试异常: ${e?.message || e}`, kind: 'error' })
      if (this.testCtx) this.finishTest(epoch)
    })
  }

  /** 数据驱动：逐组顺序执行（上一组跑完再下一组；中途停止则跳出），最后合并报告 */
  private async execTestSequence(
    tc: TestCase,
    groups: TestGroup[],
    settings: Settings,
    opts: { failFast: boolean; fillPreview?: boolean; loginReuse?: boolean; caseId?: number; env?: { name: string; baseUrl: string; protected: boolean } },
    epoch: number
  ): Promise<void> {
    const multi = groups.length > 1
    if (multi) this.testGroupResults = []
    this.testCollectMode = multi
    let stoppedEarly = false
    try {
      for (let gi = 0; gi < groups.length; gi++) {
        if (epoch !== this.epoch) return // 已被新运行取代
        if (this.state.state === 'stopped') {
          stoppedEarly = true
          break
        }
        if (gi > 0) await new Promise((r) => setTimeout(r, 1200)) // 组间稍歇，界面/遮罩状态落地
        await this.runTestOnce(tc, groups[gi], settings, opts, epoch)
      }
    } finally {
      if (this.state.state === 'stopped') stoppedEarly = true
      this.testCollectMode = false
      const results = this.testGroupResults
      this.testGroupResults = []
      if (epoch !== this.epoch) return
      if (multi && results.length) {
        const merged = this.mergeGroupRuns(results, tc, opts.env?.name, stoppedEarly)
        this.testRun = merged
        this.broadcastTestRun()
        const verdict =
          merged.state === 'passed' ? '✅ 全部通过' : merged.state === 'stopped' ? '⏹️ 已停止' : `❌ 失败 ${merged.failed}/${merged.totalSteps} 步`
        this.broadcast({ channel: 'toast', message: `多组测试结束: ${verdict}`, kind: merged.state === 'passed' ? 'success' : 'error' })
        this.setState({
          state: merged.state === 'stopped' ? 'stopped' : 'done',
          statusText: `测试结束: ${verdict}（${results.length} 组）`,
          result: `${verdict}（${results.length} 组 · 通过 ${merged.passed}/${merged.totalSteps}）${merged.reportPath ? `\n报告: ${merged.reportPath}` : ''}`,
          stepCount: this.steps.length
        })
      }
    }
  }

  /** 合并多组结果：步骤展平（组名前缀）+ 截图重定位 + 汇总判定 + 写合并报告 */
  private mergeGroupRuns(
    results: Array<{ name: string; run: TestRunStatus; shots: Map<number, string> }>,
    tc: TestCase,
    envName: string | undefined,
    stoppedEarly: boolean
  ): TestRunStatus {
    const steps: TestStepResult[] = []
    const shotMap = new Map<number, string>()
    let si = 0
    for (const g of results) {
      for (const s of g.run.steps) {
        si++
        steps.push({ ...s, index: si, title: `[${g.name}] ${s.title}` })
        if (s.status === 'failed' && g.shots.has(s.index)) shotMap.set(si, g.shots.get(s.index)!)
      }
    }
    const passed = steps.filter((s) => s.status === 'passed').length
    const failed = steps.length - passed
    const merged: TestRunStatus = {
      state: stoppedEarly ? 'stopped' : failed === 0 ? 'passed' : 'failed',
      caseName: tc.name,
      envName,
      totalSteps: steps.length,
      currentStep: steps.length,
      steps,
      passed,
      failed,
      startedAt: results[0].run.startedAt,
      endedAt: results[results.length - 1].run.endedAt || Date.now(),
      tokens: results.reduce((acc, r) => ({ input: acc.input + (r.run.tokens?.input || 0), output: acc.output + (r.run.tokens?.output || 0) }), { input: 0, output: 0 })
    }
    try {
      merged.reportPath = writeTestReport(merged, tc, shotMap)
    } catch (e) {
      console.error('[easybow] 多组测试报告写入失败:', e)
    }
    return merged
  }

  /** 单组运行：setup → 登录态预热探测 → 复用主循环 → finishTest 收尾（Promise 在收尾时兑现） */
  private runTestOnce(
    tc: TestCase,
    group: TestGroup,
    settings: Settings,
    opts: {
      failFast: boolean
      fillPreview?: boolean
      loginReuse?: boolean
      caseId?: number
      env?: { name: string; baseUrl: string; protected: boolean }
    },
    epoch: number
  ): Promise<TestRunStatus> {
    return new Promise<TestRunStatus>((resolve) => {
      const provider = createProvider(settings)
      // 独立测试页签（登录态与日常浏览互不污染）；页签满时让用户先关页签
      const tab = this.tabManager.ensureTestTab()
      tab.cdp.setDialogPolicy('accept') // JS 原生弹窗自动应答（仅测试期间启用，结束即关闭）
      tab.cdp.setNetworkCapture(true) // 网络级断言（api_status/api_body）捕获，结束即关闭
      Cdp.defaultDialogPolicy = 'accept' // 测试中新开的页签（如 window.open）同样接管弹窗

      this.testSoftErrors = []
      this.testCtx = {
        epoch,
        tc,
        stepIdx: 0,
        failFast: opts.failFast,
        protectedSubmit: !!opts.env?.protected,
        fillPreview: !!opts.fillPreview,
        envName: opts.env?.name,
        caseId: opts.caseId,
        perStepModelSteps: 0,
        loginReuse: opts.loginReuse !== false,
        loggedIn: null,
        loginWarned: false
      }
      this.testRun = {
        runId: epoch,
        state: 'running',
        caseName: tc.name,
        envName: opts.env?.name,
        groupName: group.name || undefined,
        totalSteps: tc.steps.length,
        currentStep: 0,
        steps: tc.steps.map((s, i) => ({
          index: i + 1,
          title: s.title,
          status: 'pending',
          assertions: [],
          modelSteps: 0
        })),
        passed: 0,
        failed: 0,
        startedAt: Date.now(),
        tokens: { input: 0, output: 0 }
      }
      this.broadcastTestRun()

      const task = `🧪 测试: ${tc.name}${group.name ? ` [${group.name}]` : ''}`
      this.steps = []
      this.lastResults = []
      this.pendingGuidance = []
      this.lastExecutedActions = []
      this.loginHintedHosts.clear()
      this.visionFallbackLeft = 0
      this.locateFailStreak = 0
      this.abortCtrl = new AbortController()
      this.pauseRequested = false
      this.setState({
        state: 'running',
        task,
        stepCount: 0,
        statusText: `测试启动: ${task.slice(3)}`,
        usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
        // 本组数据变量 + 环境 base_url 注入记忆（{{变量}} 替换全链路生效）
        memory: { ...group.vars, ...(opts.env?.baseUrl ? { base_url: opts.env.baseUrl } : {}) },
        result: undefined
      })
      this.testDoneResolve = { epoch, resolve }
      // 登录态预热：先真访问目标站点（否则分区里的 Cookie 无从体现），再探测是否已登录
      const warmup = this.testCtx.loginReuse
        ? this.warmupLoginState(this.testCtx, opts.env?.baseUrl).catch(() => undefined)
        : Promise.resolve()
      warmup.then(() => {
        if (epoch !== this.epoch) {
          // 预热期间已被新运行取代：不要启动旧循环
          const r = this.testDoneResolve
          if (r && r.epoch === epoch) {
            this.testDoneResolve = null
            r.resolve(this.getTestRunStatus() || ({} as TestRunStatus))
          }
          return
        }
        const p = this.loop(task, provider, settings, epoch)
          .catch((e) => {
            if (epoch !== this.epoch) return
            this.setState({ state: 'error', statusText: `测试异常: ${e?.message || e}` })
            this.broadcast({ channel: 'toast', message: `测试异常: ${e?.message || e}`, kind: 'error' })
          })
          .finally(() => {
            if (this.loopActive === p) this.loopActive = null
            if (this.testCtx && this.testCtx.epoch === epoch) this.finishTest(epoch)
            // 兜底：finishTest 未兑现（不应发生）也必须解锁序列
            const r = this.testDoneResolve
            if (r && r.epoch === epoch) {
              this.testDoneResolve = null
              r.resolve(this.getTestRunStatus() || ({} as TestRunStatus))
            }
          })
        this.loopActive = p
      })
    })
  }

  /**
   * 登录态预热：把测试页签先导航到用例的目标站点，等页面稳定后探测登录态。
   * 命中（分区里已有有效登录）→ 后续「登录类」步骤直接跳过；失效/未知 → 照常执行登录。
   */
  private async warmupLoginState(tctx: TestExecCtx, baseUrl?: string): Promise<void> {
    const url = pickWarmupUrl(tctx.tc, baseUrl)
    const tab = this.tabManager.getTestTab()
    if (!url || !tab) return
    try {
      await tab.view.webContents.loadURL(url).catch(() => undefined)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        let loading = false
        try {
          loading = tab.view.webContents.isLoading()
        } catch {
          break
        }
        if (!loading) break
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 700))
      const p = await probeLoginState(tab)
      tctx.loggedIn = p.loggedIn ? true : p.needLogin ? false : null
      tctx.loginDetail = p.detail
      if (p.loggedIn) {
        this.lastResults.push(
          `系统提示: 登录态复用已命中（${p.detail}）——后续测试步骤中的「登录」操作会自动跳过，直接执行其后的业务步骤。`
        )
      }
    } catch {
      tctx.loggedIn = null
    }
  }

  /** 每步刷新登录态（测试模式 + 登录态复用开启时；一次轻量 evaluate） */
  private async refreshLoginState(): Promise<void> {
    const tctx = this.testCtx
    if (!tctx || !tctx.loginReuse) return
    try {
      const tab = this.tabManager.getTestTab() || this.tabManager.active()
      const p = await probeLoginState(tab)
      if (p.loggedIn) tctx.loggedIn = true
      else if (p.needLogin) tctx.loggedIn = false
      tctx.loginDetail = p.detail
    } catch {}
  }

  /**
   * 登录态复用判定：当前步骤是登录类且已确认登录 → 直接判过并推进到下一步。
   * 返回 'skip' = 已跳过并推进（调用方 continue）、'end' = 已无后续步骤（应结束）、'no' = 不跳过。
   */
  private consumeLoginSkip(): 'no' | 'skip' | 'end' {
    const tctx = this.testCtx
    const run = this.testRun
    if (!tctx || !run || !tctx.loginReuse || tctx.loggedIn !== true) return 'no'
    const step = tctx.tc.steps[tctx.stepIdx]
    if (!isLoginStep(step)) return 'no'
    const cur = run.steps[tctx.stepIdx]
    if (!cur || cur.status === 'passed' || cur.status === 'failed') return 'no'
    cur.status = 'passed'
    cur.note = '已复用保存的登录态，跳过登录操作'
    cur.assertions.push({ raw: '[自动] 复用已保存登录态（跳过登录操作）', kind: 'soft', passed: true })
    if (!this.advanceTestStep()) return 'end'
    this.broadcastTestRun()
    return 'skip'
  }

  /** 推进到下一步骤（软断言随步骤消费清空）；返回 false=已无后续步骤 */
  private advanceTestStep(): boolean {
    const tctx = this.testCtx
    const run = this.testRun
    if (!tctx || !run) return false
    tctx.stepIdx++
    tctx.perStepModelSteps = 0
    this.testSoftErrors = []
    run.passed = run.steps.filter((s) => s.status === 'passed').length
    run.failed = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').length
    if (tctx.stepIdx >= tctx.tc.steps.length) {
      run.currentStep = run.totalSteps
      return false
    }
    run.currentStep = tctx.stepIdx + 1
    return true
  }

  /**
   * 测试收尾（幂等）：未执行步骤标 skipped、算通过率、失败步骤截图落盘、写报告、
   * 关闭弹窗自动应答、清 testCtx。由 loop 结束路径（done/异常/停止/fail-fast）统一触发。
   */
  private finishTest(epoch?: number): void {
    const tctx = this.testCtx
    const run = this.testRun
    if (!tctx || !run || run.state !== 'running') return
    // 旧循环收尾不得污染新运行（旧 bug：点停止后立刻再运行，旧循环把新 run 提前判死）
    if (epoch != null && (epoch !== this.epoch || tctx.epoch !== epoch)) return
    try {
      this.tabManager.getTestTab()?.cdp.setDialogPolicy(null)
      this.tabManager.getTestTab()?.cdp.setNetworkCapture(false)
      Cdp.defaultDialogPolicy = null
    } catch {}
    for (const s of run.steps) {
      if (s.status === 'pending' || s.status === 'running') {
        s.status = 'skipped'
        if (!s.error) s.error = '未执行（测试提前结束）'
      }
    }
    run.passed = run.steps.filter((s) => s.status === 'passed').length
    run.failed = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').length
    const agentState = this.state.state
    let state: TestRunStatus['state']
    if (agentState === 'stopped') state = 'stopped'
    else if (agentState === 'error') state = 'error'
    else state = run.failed === 0 ? 'passed' : 'failed'
    run.state = state
    run.endedAt = Date.now()
    run.tokens = { input: this.state.usage.inputTokens, output: this.state.usage.outputTokens }
    // 失败步骤的最终截图落盘（从时间线里倒查该测试步骤的最后一张截图）
    const shots = new Map<number, string>()
    if (this.steps.length) {
      for (const s of run.steps) {
        if (s.status !== 'failed') continue
        for (let i = this.steps.length - 1; i >= 0; i--) {
          const rec = this.steps[i]
          if (rec.testStep === s.index && rec.screenshot) {
            shots.set(s.index, rec.screenshot)
            break
          }
        }
      }
    }
    if (this.testCollectMode) {
      // 多组收集模式：本组结果与截图暂存，报告由 mergeGroupRuns 统一写
      this.testGroupResults.push({ name: run.groupName || '', run: this.getTestRunStatus()!, shots })
    } else {
      try {
        run.reportPath = writeTestReport(run, tctx.tc, shots)
      } catch (e) {
        console.error('[easybow] 测试报告写入失败:', e)
      }
    }
    this.testCtx = null
    this.broadcastTestRun()
    const verdict =
      state === 'passed' ? '✅ 全部通过' : state === 'failed' ? `❌ 失败 ${run.failed}/${run.totalSteps} 步` : `⚠️ 测试${state}`
    // 来源用例库：回写最近运行结论（多组时最后一组的 caseId 相同，多次回写幂等）
    if (tctx.caseId != null) {
      try {
        updateCaseRunStat(tctx.caseId, verdict)
      } catch {}
    }
    this.broadcast({ channel: 'toast', message: `测试结束: ${verdict}`, kind: state === 'passed' ? 'success' : 'error' })
    this.setState({
      state: state === 'stopped' ? 'stopped' : state === 'error' ? 'error' : 'done',
      statusText: `测试结束: ${verdict}`,
      result: `${verdict}（通过 ${run.passed}/${run.totalSteps}）${run.reportPath ? `\n报告: ${run.reportPath}` : ''}`,
      stepCount: this.steps.length
    })
    // 兑现 execTestSequence 的等待（多组时进入下一组）
    const done = this.testDoneResolve
    this.testDoneResolve = null
    if (done) done.resolve(this.getTestRunStatus() || ({} as TestRunStatus))
  }

  /** 测试脚本区块（注入每步 user 消息；含当前步骤每条预期应输出的确切 expect JSON） */
  private buildTestScriptContext(): TestScriptContext {
    const tctx = this.testCtx!
    const run = this.testRun!
    const scriptStep = tctx.tc.steps[tctx.stepIdx]
    const cur = run.steps[tctx.stepIdx]
    if (cur && cur.status === 'pending') {
      cur.status = 'running'
      run.currentStep = tctx.stepIdx + 1
      // 该步骤的弹窗应答策略（缺省=确认）
      try {
        this.tabManager.getTestTab()?.cdp.setDialogPolicy(scriptStep.dialog || 'accept')
      } catch {}
      this.broadcastTestRun()
    }
    const mem = this.state.memory
    const dataLines = Object.entries(mem)
      .slice(0, 20)
      .map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + '…(用{{' + k + '}}引用)' : v}`)
      .join('\n')
    const progressLines = run.steps
      .slice(0, tctx.stepIdx)
      .map((s) => `${s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : '⏭️'} 步骤${s.index}: ${s.title}`)
      .join('\n')
    const lines: string[] = []
    lines.push(`### ${scriptStep.title}`)
    lines.push(`- 操作: ${scriptStep.action}`)
    for (const asrt of scriptStep.assertions) {
      if (asrt.kind === 'ai') {
        lines.push(`- 预期: ${asrt.raw} → 把这条自然语言预期翻译成合适的 expect 动作输出`)
      } else {
        lines.push(`- 预期: ${asrt.raw} → 输出 ${JSON.stringify(assertionToAction(asrt))}`)
      }
    }
    if (scriptStep.dialog) lines.push(`- 弹窗: ${scriptStep.dialog === 'accept' ? '确认' : '取消'}（系统自动应答）`)
    // 登录态复用：已登录时登录类步骤由系统直接判过；会话失效（踩到登录页）时提醒模型先登录
    if (tctx.loginReuse) {
      if (isLoginStep(scriptStep) && tctx.loggedIn === true) {
        lines.push('- 系统提示: 已检测到保存的登录态，本步骤无需执行登录操作（系统会自动判过并推进）')
      } else if (tctx.loggedIn === false && !isLoginStep(scriptStep) && !tctx.loginWarned) {
        tctx.loginWarned = true
        lines.push(
          `- 系统提示: 当前页面看起来需要登录（登录态可能已失效/被踢出，探测: ${tctx.loginDetail || '—'}）。请先完成登录（填账号密码并提交）再继续本步骤的操作，不要跳过。`
        )
      }
    }
    return { dataLines, progressLines, stepNo: tctx.stepIdx + 1, totalSteps: tctx.tc.steps.length, currentBlock: lines.join('\n') }
  }

  /**
   * 测试模式批后处理：收集断言结果、按 test_step_done 推进步骤指针、fail-fast 终止。
   * 返回 false = 结束测试循环（收尾统一走 finishTest）。
   */
  private async handleTestPostBatch(executed: AgentAction[], stepDoneSignal: boolean): Promise<boolean> {
    const tctx = this.testCtx
    const run = this.testRun
    if (!tctx || !run) return false
    const cur = run.steps[tctx.stepIdx]
    if (!cur) return false
    tctx.perStepModelSteps++
    cur.modelSteps = tctx.perStepModelSteps

    // 收集本批 expect 断言结果
    for (const e of executed) {
      if (e.name !== 'expect') continue
      cur.assertions.push({
        raw: `[${e.kind}${e.negate ? '/不' : ''}] ${e.value || e.selector || ''}`,
        kind: String(e.kind),
        passed: !e.error,
        actual: e.error ? e.error.replace(/^断言失败:.*实际=/, '').slice(0, 150) : undefined
      })
    }
    // 软断言（提交后校验错误提示，executor 在 click 时推入）：并入断言展示与判定
    for (const msg of this.testSoftErrors) {
      const raw = `[自动] ${msg}`
      if (!cur.assertions.some((x) => x.raw === raw)) {
        cur.assertions.push({ raw, kind: 'soft', passed: false, actual: msg })
      }
    }

    const hardFail = executed.some((a) => a.error && a.name !== 'expect')
    const assertFail = cur.assertions.some((x) => !x.passed)

    if (stepDoneSignal && !hardFail) {
      const scriptStep = tctx.tc.steps[tctx.stepIdx]
      const missing = Math.max(0, (scriptStep?.assertions.length || 0) - cur.assertions.filter((x) => x.kind !== 'soft').length)
      if (assertFail || missing > 0) {
        cur.status = 'failed'
        if (!cur.error) cur.error = assertFail ? '断言失败' : `有 ${missing} 条预期未输出断言`
      } else {
        cur.status = 'passed'
      }
      // 登录步骤真正跑通后刷新登录态标记（其后的步骤不再重复登录；失效时由每步探针重新判 false）
      if (cur.status === 'passed' && isLoginStep(scriptStep)) {
        tctx.loggedIn = true
        tctx.loginWarned = false
      }
      if (cur.status === 'failed' && tctx.failFast) {
        this.broadcastTestRun()
        return false // fail-fast：直接结束循环，finishTest 收尾
      }
      // 推进到下一步骤（软断言随步骤消费清空）
      tctx.stepIdx++
      tctx.perStepModelSteps = 0
      this.testSoftErrors = []
      run.passed = run.steps.filter((s) => s.status === 'passed').length
      run.failed = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').length
      if (tctx.stepIdx >= tctx.tc.steps.length) {
        this.broadcastTestRun()
        return false // 全部步骤走完，收尾交给 finishTest（→ passed）
      }
      run.currentStep = tctx.stepIdx + 1
      this.broadcastTestRun()
      return true
    }

    // 未收到 test_step_done：单步骤决策预算保护（防模型在一步内打转耗尽 token）
    if (tctx.perStepModelSteps >= 8) {
      cur.status = 'failed'
      cur.error = `步骤卡住：超出单步骤 8 次决策预算`
      if (tctx.failFast) {
        this.broadcastTestRun()
        return false
      }
      tctx.stepIdx++
      tctx.perStepModelSteps = 0
      run.currentStep = Math.min(tctx.stepIdx + 1, run.totalSteps)
      this.broadcastTestRun()
    }
    return true
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
    // 立即收尾测试状态：loop 可能卡在不可中断的 CDP/模型调用上（要等它自然退出才收尾的话，
    // UI 会一直停在「执行中」，且「运行」按钮被禁用 → 表现为点运行没反应）
    if (this.testCtx) this.finishTest(this.testCtx.epoch)
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
    settings: Pick<Settings, 'maxSteps' | 'maxElements' | 'vision' | 'visionFallback' | 'baseURL' | 'model' | 'aiMode'>,
    epoch: number
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
      // 暂停等待 / 停止判定（返回 false 则任务结束；epoch 失配=已被新运行取代）
      if (!(await this.checkpoint(epoch))) return
      const signal = this.abortCtrl!.signal

      // 模型步数（人工指导不算步数预算）；测试模式放宽（一个测试步骤可能消耗多个模型步）
      const stepN = this.steps.filter((s) => !s.userGuidance).length + 1
      const maxSteps = this.testCtx
        ? Math.max(settings.maxSteps, this.testCtx.tc.steps.length * 8 + 6)
        : settings.maxSteps
      if (stepN > maxSteps) {
        this.setState({
          state: 'done',
          statusText: `已达到最大步数 ${maxSteps}，任务结束`,
          result: `已达最大步数 ${maxSteps}。如需继续，可重新发起任务。`
        })
        return
      }

      // 0. 登录态复用：已登录时跳过「登录类」步骤（跳过即推进，可能直接跑完整个用例）
      if (this.testCtx) {
        const r = this.consumeLoginSkip()
        if (r === 'end') return // 收尾统一走 finishTest
        if (r === 'skip') continue
      }

      const tab = this.tabManager.active()
      if (!tab) throw new Error('没有可用页签，请新建页签后再开始任务')

      // 0.5 登录态刷新（测试模式 + 开启复用；一次轻量探针，约几十毫秒）
      if (this.testCtx) await this.refreshLoginState()

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

      // DOM 提取稀疏 / 视觉兜底生效但模型看不了图 → OCR 整页识别兜底（图片型页面、Canvas 应用）
      const ocrWanted = extract.candidates.length < 3 || (this.visionFallbackLeft > 0 && (visionUnsupported.has(visionKey) || visionDegraded))
      if (ocrWanted && this.ocrEnhancer) {
        try {
          const ocrText = await ocrPageText(this.tabManager)
          if (ocrText) {
            this.lastResults.push(`[OCR整页识别] 页面可交互元素极少或截图无法发给模型，以下是整页截图 OCR 文字:\n${ocrText.slice(0, 4000)}`)
          }
        } catch {}
      }
      if (extract.candidates.length === 0) this.locateFailStreak++ // 一个元素都提不出来：定位困难

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
      // 视觉兜底：元素列表定位不到目标时临时开几步「看图定位」（含坐标点击），
      // 不必为了偶尔的疑难页面全程开着视觉模式烧 token
      const fallbackAllowed = settings.visionFallback !== false && !visionDegraded && !visionUnsupported.has(visionKey)
      const visionForced = fallbackAllowed && this.visionFallbackLeft > 0
      if (this.visionFallbackLeft > 0) this.visionFallbackLeft--
      const kbTips = matchKB(tab.url).map((e) => ({ domain: e.domain, problem: e.problem, solution: e.solution }))
      // 快照当前排队指导（调用成功前不出队：暂停中断重跑本步时指导不丢）
      const guidanceCount = this.pendingGuidance.length
      const guidance = this.pendingGuidance.slice(0, guidanceCount)
      if (localCooldown > 0) localCooldown--

      // 3.5 混合模式：本地快速决策直出简单步骤（严格门控 + 契约校验；失败/不确定立即回退云端）
      let localParsed: { thought: string; actions: AgentAction[] } | null = null
      if (
        settings.aiMode === 'hybrid' &&
        !this.testCtx && // 测试模式：脚本保真与断言要求高，一律云端决策
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
        if (visionActive || visionForced) {
          try {
            visionShot = await tab.cdp.screenshotJpeg(70)
          } catch {}
        }
        useVision = (visionActive || visionForced) && !!visionShot
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
          kbTips,
          test: this.testCtx ? this.buildTestScriptContext() : undefined
        })
        this.lastResults = []
        this.setState({
          statusText: `第 ${stepN} 步：模型思考中${useVision ? (visionActive ? '（👁视觉）' : '（👁视觉兜底·看图定位）') : ''}…（当前累计 ${
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
        // 测试模式追加测试规则段（普通任务追加空串，提示词逐字节不变）
        // 视觉兜底步用 FALLBACK 段：额外放行「按截图坐标点击」，解决元素列表里根本没有目标的情况
        const systemPrompt =
          (useVision ? SYSTEM_PROMPT + (visionActive ? VISION_ADDON : VISION_FALLBACK_ADDON) : SYSTEM_PROMPT) +
          (this.testCtx ? TEST_MODE_ADDON : '')

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

      // 5. 执行动作批（测试模式：test_step_done 是控制信号，进执行器前剥离；protectedSubmit 透传生产保护）
      this.setState({ statusText: `第 ${stepN} 步：执行 ${parsed.actions.length} 个动作…`, usage })
      const stepDoneSignal = !!this.testCtx && parsed.actions.some((x) => x.name === 'test_step_done')
      const executed = await this.executor.executeBatch(
        this.testCtx ? parsed.actions.filter((x) => x.name !== 'test_step_done') : parsed.actions,
        {
          memory: this.state.memory,
          signal,
          settings: getSettings(),
          prevActions: this.lastExecutedActions,
          protectedSubmit: this.testCtx?.protectedSubmit,
          // 测试模式专属执行开关（普通任务恒缺省，executor 分支不进入）
          softAssert: this.testCtx ? true : undefined,
          fillPreview: this.testCtx?.fillPreview,
          softErrors: this.testCtx ? this.testSoftErrors : undefined
        }
      )
      // 只认实际执行成功的 done（暂停/出错打断批次时不应误判完成）
      const doneAction = executed.find((a) => a.name === 'done' && !a.error)
      // 供 repeat 重放：剥离大文本字段，只留动作骨架（测试动作 expect/test_step_done 无重放意义，一并排除）
      this.lastExecutedActions = executed
        .filter((a) => a.name !== 'done' && a.name !== 'expect' && a.name !== 'test_step_done')
        .map(({ result: _r, error: _e, ...rest }) => rest)

      // 视觉兜底触发：连续定位失败（元素失效/不可见/页面提不出元素）→ 接下来 3 步带截图让模型看图定位
      const locateFail = executed.some(
        (a) => !!a.error && /已失效|不可见|找不到|无法定位|没有可点击|超出范围/.test(a.error)
      )
      if (locateFail) this.locateFailStreak++
      else if (!locateFail && executed.some((a) => !a.error)) this.locateFailStreak = 0
      if (this.locateFailStreak >= 2 && fallbackAllowed && this.visionFallbackLeft === 0) {
        this.visionFallbackLeft = 3
        this.locateFailStreak = 0
        this.lastResults.push(
          '系统提示: 连续定位不到目标元素，已临时开启「视觉兜底」——接下来几步会附带页面截图，你可以直接用 {"name":"click_xy","x":500,"y":300} 按截图上的归一化坐标（0~1000）点击目标；能找到元素编号时仍优先用 click index。'
        )
        this.setState({ statusText: `第 ${stepN} 步：元素定位失败，已开启视觉兜底（截图定位）` })
      }

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

      // 原生弹窗自动应答反馈（普通/测试任务统一）：文案告知模型，下一步可判断是否补救
      const dlgNow = (() => {
        try {
          return tab.cdp.consumeDialogs()
        } catch {
          return null
        }
      })()
      if (dlgNow) {
        this.lastResults.push(
          `系统提示: 页面弹出了原生确认框，系统已自动应答: ${dlgNow}。若该确认不是本任务期望的操作，请说明并纠正；页面内的 DOM 弹窗/遮罩是普通元素，直接按编号操作即可`
        )
      }

      // 6. 记录步骤（含视口截图；视觉模式标记模型确实收到了截图）
      const screenshot = await tab.cdp.screenshotJpeg()
      const step = this.recordStep(stepN, parsed.thought, executed, tab, {
        input: llmOut.usage.inputTokens,
        output: llmOut.usage.outputTokens
      }, screenshot || undefined)
      if (useVision && !visionRetryUsed) step.vision = true
      if (localUsed) step.local = true
      if (this.testCtx) step.testStep = this.testCtx.stepIdx + 1
      this.broadcast({ channel: 'step', step })

      // 测试模式：断言收集 / 步骤推进 / fail-fast（返回 false 结束循环，收尾统一走 finishTest）
      if (this.testCtx && !(await this.handleTestPostBatch(executed, stepDoneSignal))) return

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
