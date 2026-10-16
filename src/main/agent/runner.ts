import { Executor } from '../executor'
import { DETECT_FRICTION_FN, pageHashOf, type ExtractResult } from '../extractor'
import { Cdp } from '../cdp'
import type { TabManager } from '../tabs'
import { getSettings } from '../settings'
import { matchKB } from '../knowledge'
import { matchExperience, upsertExperience, feedbackExperience } from '../experience'
import { Telemetry, type TraceEventType } from '../telemetry'
import { diagnose, type Diagnosis } from '../diagnose'
import { fetchAxTree, annotateWithAx } from '../axtree'
import { scoreCandidate } from '../semantic'
import {
  buildStepMessage,
  buildModeSuffix,
  SYSTEM_PROMPT,
  VISION_ADDON,
  VISION_FALLBACK_ADDON,
  CANVAS_EDITOR_ADDON,
  TEST_MODE_ADDON,
  LOCAL_SYSTEM_PROMPT,
  buildLocalPrompt,
  type TestScriptContext
} from './prompts'
import {
  PLAN_SYSTEM_PROMPT,
  REPLAN_SYSTEM_PROMPT,
  buildReplanPrompt,
  buildPlanPrompt,
  buildPlanSnapshot,
  parsePlan,
  validatePlan,
  renderPlanIssues,
  type PlanPageSnapshot
} from './plan'
import { verifyNode, type Verdict } from './verify'
import {
  createProvider,
  createPlannerProvider,
  hasPlannerConfig,
  probeStructuredSupport,
  isVisionUnsupportedError,
  outputBudget,
  isBudgetEscalated,
  escalateBudget,
  LEGACY_BUDGET,
  type ContentPart,
  type LlmProvider
} from './llm'
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
  PlanNode,
  PlanNodeState,
  Settings,
  StepRecord,
  StepTimings,
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

/**
 * v4.5 P2-3 状态复位探针（页内自包含注入函数）。
 *
 * 在「坏状态」上重试同一个动作必然失败：残留弹窗挡住目标、页面滚到一半导致元素判定不可见、
 * 上一次 file input 残留。关掉这些再重试，成本约 200ms，成功率提升远高于此。
 *
 * 安全约束：**只关不含任务关键词的 role=dialog 遮罩**——任务本身需要的中间态弹窗
 * （如「请确认收货地址」向导步骤）绝不能被自动关掉，否则会破坏任务进度。
 */
const RECOVER_PAGE_FN = String(function recoverPage(task: string) {
  let closed = 0
  const kws = (task || '').replace(/\s+/g, '')
  const masks = document.querySelectorAll(
    '.ant-modal-mask,.el-dialog__wrapper,.el-drawer__container,.van-overlay,.chakra-modal__overlay,[role="dialog"]'
  )
  for (const m of Array.from(masks)) {
    try {
      const r = (m as HTMLElement).getBoundingClientRect()
      if (r.width < 40 || r.height < 40) continue // 隐藏容器不算弹窗
      // 弹窗文案含任务关键词 → 是任务流程的一部分，绝不自动关
      const body = (m as HTMLElement).innerText || ''
      if (kws && kws.length >= 4 && body.replace(/\s+/g, '').includes(kws.slice(0, 6))) continue
      // 找关闭按钮：aria-label / title / 常见的关闭类名；没有就放弃关（宁可不关也不误关）
      const btn = m.querySelector(
        '.ant-modal-close,.el-dialog__headerbtn,.van-dialog__header__close,[aria-label="Close"],[aria-label="关闭"],[title="关闭"],button[class*="close" i]'
      ) as HTMLElement | null
      if (!btn) continue
      btn.click()
      closed++
    } catch {}
  }
  // file input 残留：上一次上传留下的文件名会误导下一轮
  try {
    for (const fi of Array.from(document.querySelectorAll('input[type=file]'))) {
      if ((fi as HTMLInputElement).value) {
        ;(fi as HTMLInputElement).value = ''
        closed++
      }
    }
  } catch {}
  let scrolled = false
  try {
    if (window.scrollY > 40) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      scrolled = true
    }
  } catch {
    try {
      if (window.scrollY > 40) {
        window.scrollTo(0, 0)
        scrolled = true
      }
    } catch {}
  }
  return { closed, scrolled }
})

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

/** v4.3 任务总耗时的友好格式（完成 toast/状态用）：890ms / 5.3s / 2分31秒 */
function fmtTaskDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return sec ? `${m}分${sec}秒` : `${m}分钟`
}

/**
 * 动作必填参数校验（参数契约前置拦截）：缺参动作不进执行批，直接标错误给模型——
 * 此前「click 无 index」要走到执行器才报错，每次白烧一步模型调用（WPS 任务 trace：6 次）。
 * 返回缺失字段名（无可选字段冲突时给主字段名），完整返回 null。
 */
function missingActionParam(a: AgentAction): string | null {
  const has = (v: unknown) => v !== undefined && v !== null && v !== ''
  switch (a.name) {
    case 'click':
    case 'drag':
    case 'upload':
    case 'switch_tab':
    case 'close_tab':
      return has(a.index) ? null : 'index'
    case 'type':
      return has(a.index) ? (has(a.text) ? null : 'text') : 'index'
    case 'goto':
      return has(a.url) ? null : 'url'
    case 'save':
    case 'recall':
      return has(a.key) ? null : 'key'
    case 'wait_for':
      return has(a.value) || has(a.text) ? null : 'value'
    case 'click_xy':
      return has(a.x) ? (has(a.y) ? null : 'y') : 'x'
    case 'clarify':
      return has(a.query) || has(a.text) ? null : 'query'
    case 'paste_rich':
      return has(a.text) ? null : 'text'
    case 'paste_image':
      return has(a.url) ? null : 'url'
    default:
      return null
  }
}

/** 宽松解析模型输出的 JSON（容忍 markdown 围栏、前后杂文） */
function parseModelJson(text: string): { thought: string; actions: AgentAction[]; nodeDone?: boolean; nodeEvidence?: string } | null {  let t = text.trim()
  t = t.replace(/```(?:json)?/gi, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = t.slice(start, end + 1)
  try {
    const obj = JSON.parse(slice)
    if (!obj || typeof obj !== 'object') return null
    const thought = String(obj.thought || '').slice(0, 300)
    // 节点链模式：模型声明「当前节点的预期已达成」，触发系统复核
    const nodeDone = obj.node_done === true || obj.nodeDone === true ? true : undefined
    // v4.5：node_done 必须附证据（引用本步动作编号或描述观察到的页面变化）。
    // 无证据的「我做完了」不作为通过依据——复核层会把它降级为「不确定」。
    const rawEv = obj.node_evidence ?? obj.nodeEvidence
    const nodeEvidence = rawEv != null && String(rawEv).trim() ? String(rawEv).trim().slice(0, 200) : undefined
    let actions = Array.isArray(obj.actions) ? obj.actions : []
    actions = actions
      .filter((a: any) => a && typeof a.name === 'string')
      .slice(0, 5)
      .map((a: any) => ({
        name: a.name,
        index: typeof a.index === 'number' ? a.index : undefined,
        // v4.5 元素指纹：与 index 二选一，跨步骤稳定（页面重排后编号会变、fp 不变）
        fp: typeof a.fp === 'string' && /^[0-9a-f]{3,8}$/i.test(a.fp) ? a.fp.toLowerCase() : undefined,
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
        y: typeof a.y === 'number' ? a.y : undefined,
        // v4.4 点击预期文案（click/click_xy 语义核验契约；同名按钮须含行标识）
        expect_text: a.expect_text != null ? String(a.expect_text).slice(0, 120) : undefined,
        // S4 多候选（系统语义裁决）+ 不确定度 + clarify 问题
        candidates:
          Array.isArray(a.candidates) && a.candidates.every((n: any) => typeof n === 'number')
            ? a.candidates.slice(0, 5)
            : undefined,
        uncertain: typeof a.uncertain === 'number' ? a.uncertain : undefined,
        query: a.query != null ? String(a.query).slice(0, 300) : undefined
      }))
    return { thought, actions, nodeDone, nodeEvidence }
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
  /** v4.5 P2-3：状态复位探针的步级冷却（每 N 步最多复位一次，避免连续失败下反复触发） */
  private recoverCooldown = 0
  /** v4.4 L5：零 delta 点击熔断重试已用次数（每任务上限 2 次，防无限重试） */
  private zeroDeltaRetries = 0
  /** 节点链计划（复核模式；计划生成失败/复核关闭时为空 = 无节点链执行） */
  private plan: PlanNode[] = []
  /** 当前节点下标（0-based） */
  private planIdx = 0
  /** 每个节点的运行状态（UI 节点进度条） */
  private nodeStatuses: PlanNodeState[] = []
  /** 每个节点最近一次复核未通过的原因（UI 展示） */
  private nodeReasons: (string | undefined)[] = []
  /** 当前节点连续复核未通过次数（达阈值升级人工） */
  private nodeFails = 0
  /** 上一次复核未通过的原因（同样原因连续失败更快升级，避免盲目重试） */
  private nodeLastFailReason = ''
  /** done 被节点链拦下的次数（防死循环：拦 2 次后尊重模型判断收尾） */
  private doneHeld = 0
  /* —— v2.0 智能增强运行态 —— */
  /** S0 任务级 trace 埋点 */
  private telemetry = new Telemetry()
  /** S2 上一步提取快照（URL 对比判定 page_changed） */
  private prevExtract: ExtractResult | null = null
  /** S2 同一动作名连续失败计数（loop 判定用） */
  private failStreakName = ''
  private failStreakCount = 0
  /** S4 本任务 clarify 已用次数（上限 3，防滥用暂停） */
  private clarifyCount = 0
  /** S1 扩展提取已触发次数（每任务上限 3 次，防每步浪费） */
  private boostTried = 0
  /** R3 风控 warn 级连续次数（指数退避用） */
  private frictionWarns = 0
  /** S5 最近一次注入的人工指导（其后的批全成功 → 沉淀 lesson） */
  private lastGuidanceText = ''
  private lastFailureKind = ''
  /* —— v3.0 AI 操控升级运行态 —— */
  /** T8 反思（W7）：失败尝试清单（签名=动作名+目标语义+容器锚文本；每目标最近 3 条、全局封顶 20 条） */
  private triedList: Array<{ sig: string; method: string; reason: string }> = []
  /** T9 重规划（W8）：已触发次数（上限 2）与待触发标志 */
  private replanCount = 0
  private replanPending = ''
  /** T9 无节点推进计数（连续 3 步无推进 → 触发重规划） */
  private noProgressSteps = 0
  private progressAnchorIdx = 0
  /** T10 专家重试（W9）：卡住节点单次 planner 调用（每任务 ≤3 次，成功立即回落主模型） */
  private expertRetriesUsed = 0
  private expertArmed = false
  /** T10 planner 用量分列（重规划/专家重试消耗的 token；UI usage-bar 分列显示） */
  private plannerUsage = { inputTokens: 0, outputTokens: 0 }
  /* —— v4.6 Token 成本与提速运行态 —— */
  /** A3/B3 页面指纹链：上一步 extract 的指纹（B3 判「页面未变」用；任务启动时清空） */
  private lastPageHash = ''
  /** B3 连续省略元素列表计数（≥2 强制回全量列表，防模型在无列表状态下空转） */
  private pageOmitStreak = 0
  /** C6 截断自愈：连续「输出吃满预算且解析失败」计数（≥2 → 本任务回退 v4.5 固定预算） */
  private truncFailStreak = 0
  private legacyBudget = false
  /** B1 failSig 重复追踪（节点域）：同节点同签名第 2 次 → 立即重规划；第 3 次 → 建议 clarify */
  private fsigNode = -1
  private fsigKey = ''
  private fsigCount = 0
  /** B5 同构动作连击：连续同形状动作批计数（≥3 且页面在推进 → 注入一次 repeat 建议） */
  private sameShapeSig = ''
  private sameShapeRun = 0
  private repeatHinted = false
  /** B1 重规划 prompt 附带最近一次 delta 变化摘要（W10 产物） */
  private lastDeltaHint = ''
  /** T7 动作后核验（W10）：上一批动作（delta 比对输入） */
  private lastBatchActions: AgentAction[] = []
  /** v4.1 非预期跳转检测（用户提案）：任务起始页 URL（回滚提示里的「初始页面」）；
   *  lastJumpNotified 防同一跳转重复提醒 */
  private taskOriginUrl = ''
  private lastJumpNotified = ''
  /** v4.3 日志/耗时：任务启动时刻（完成时算总耗时） */
  private taskStartedAt = 0

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

  /* —— v4.6 计量与外部埋点通道 —— */

  /** A2：外部调用点（index.ts clickVerifier 等）向本任务 trace 写事件的公开通道 */
  logEvent(type: TraceEventType, step: number, data: Record<string, unknown>): void {
    this.telemetry.log(type, step, data)
  }

  /** A2：当前步号（外部埋点取「当前批所在步」用） */
  get currentStep(): number {
    return this.state.stepCount
  }

  /** A1：累计一次 LLM 用量到任务总账（含缓存命中分列；不改动 steps） */
  private addUsage(u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): void {
    this.setState({
      usage: {
        ...this.state.usage,
        inputTokens: this.state.usage.inputTokens + (u.inputTokens || 0),
        outputTokens: this.state.usage.outputTokens + (u.outputTokens || 0),
        cachedInputTokens: (this.state.usage.cachedInputTokens || 0) + (u.cachedInputTokens || 0)
      }
    })
  }

  /** C6：本任务生效的输出预算。三道防线：任务内截断自愈（legacyBudget）→
   *  会话级模型记忆（isBudgetEscalated，跨任务生效）→ 模型档位分档（outputBudget）。
   *  顺序：任一命中即回退 v4.5 固定预算——漏判推理模型的代价（JSON 截断）远大于多给的余量 */
  private budgetFor(site: Parameters<typeof outputBudget>[1], model: string, settings: Settings): number {
    if (settings.outputBudget === false || this.legacyBudget || isBudgetEscalated(model)) return LEGACY_BUDGET[site]
    return outputBudget(model, site)
  }

  /**
   * 暂停等待：等到「继续」后被唤醒。
   * 返回 true=继续执行，false=任务已被停止。
   */
  private async waitIfPaused(): Promise<boolean> {
    if (!this.pauseRequested) return true
    // 暂停=人工接管：临时撤掉原生弹窗自动应答，让人工自己点出的 confirm/alert
    // 正常弹出、由人工决定（否则人工点删除类操作的确认框会被系统瞬间吞掉）
    const prevPolicy = Cdp.defaultDialogPolicy
    Cdp.defaultDialogPolicy = null
    for (const t of this.tabManager.all()) {
      try {
        t.cdp.setDialogPolicy(null)
      } catch {}
    }
    this.setState({ state: this.state.state === 'captcha' ? 'captcha' : 'paused', statusText: '已暂停，等待人工操作' })
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    if (this.state.state === 'stopped') return false
    // 恢复接管：先强应答人工可能遗留的未关弹窗（否则阻塞 evaluate 挂死任务），再恢复自动应答
    Cdp.defaultDialogPolicy = prevPolicy
    for (const t of this.tabManager.all()) {
      try {
        t.cdp.setDialogPolicy(prevPolicy)
        if (prevPolicy) t.cdp.clearPendingDialog()
      } catch {}
    }
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

    // 新任务从干净界面开始：时间线/任务记忆等显示一并清空
    this.broadcast({ channel: 'steps-clear' })

    const provider = createProvider(settings)
    this.steps = []
    this.lastResults = []
    this.pendingGuidance = []
    this.lastExecutedActions = []
    this.loginHintedHosts.clear()
    this.plan = []
    this.planIdx = 0
    this.nodeStatuses = []
    this.nodeReasons = []
    this.nodeFails = 0
    this.nodeLastFailReason = ''
    this.doneHeld = 0
    this.prevExtract = null
    this.failStreakName = ''
    this.failStreakCount = 0
    this.clarifyCount = 0
    this.boostTried = 0
    this.frictionWarns = 0
    this.lastGuidanceText = ''
    this.lastFailureKind = ''
    this.triedList = []
    this.replanCount = 0
    this.replanPending = ''
    this.recoverCooldown = 0
    this.noProgressSteps = 0
    this.progressAnchorIdx = 0
    this.expertRetriesUsed = 0
    this.expertArmed = false
    this.plannerUsage = { inputTokens: 0, outputTokens: 0 }
    // v4.6 Token 成本与提速运行态复位
    this.lastPageHash = ''
    this.pageOmitStreak = 0
    this.truncFailStreak = 0
    this.legacyBudget = false
    this.fsigNode = -1
    this.fsigKey = ''
    this.fsigCount = 0
    this.sameShapeSig = ''
    this.sameShapeRun = 0
    this.repeatHinted = false
    this.lastDeltaHint = ''
    this.lastBatchActions = []
    this.zeroDeltaRetries = 0
    // v4.1 非预期跳转检测：记录任务起始页（后续步误触跳转时给模型回滚锚点）
    this.taskOriginUrl = (this.tabManager.active()?.url || '').slice(0, 300)
    this.lastJumpNotified = ''
    this.abortCtrl = new AbortController()
    this.pauseRequested = false
    // S0 trace 埋点（设置关闭时完全静默）
    this.telemetry.start(task, settings.telemetry !== false)
    // T2 智能等待：任务级熔断状态复位（host 记忆保留）+ 熔断遥测接线
    this.executor.resetWaitState()
    this.executor.onCircuitBreak = (host, url) => {
      // P0-2：host 定位站点 + url 区分同站点页面形态（页面特征）
      this.telemetry.log('circuit_break', this.steps.length + 1, { host, url: (url || '').slice(0, 200) })
    }
    // T4 结构化输出：会话建立时预检探测（不消耗真实任务请求；结果会话内粘滞）
    if (settings.structuredOut !== false) {
      probeStructuredSupport(settings).catch(() => undefined)
    }
    this.taskStartedAt = Date.now()
    this.setState({
      state: 'running',
      task,
      stepCount: 0,
      statusText: '任务启动中',
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
      memory: {},
      plan: undefined,
      result: undefined,
      startedAt: this.taskStartedAt,
      totalMs: undefined
    })
    // 异步跑循环，startTask 立即返回
    // 原生弹窗（confirm/alert）自动应答：弹窗会阻塞页面 JS 与 CDP evaluate（任务挂死），
    // 应答文案进「上一步结果」让模型知情可纠正；beforeunload 一律阻止离开
    Cdp.defaultDialogPolicy = 'accept'
    for (const t of this.tabManager.all()) t.cdp.setDialogPolicy('accept')
    const p = this.loop(task, provider, settings, epoch)
      .catch(async (e) => {
        if (epoch !== this.epoch) return // 已被新运行取代：异常归旧循环，不影响当前状态
        const msg = String(e?.message || e)
        // P1-11 错误帧兜底：渲染进程崩溃/CDP 挂死等异常收尾时，smart 模式该步无任何帧——
        // 尽力补拍一帧（失败也不阻塞收尾），时间线可回溯「最后一刻页面长什么样」
        try {
          const tab = this.tabManager.active()
          if (tab) {
            const shot = await tab.cdp.screenshotJpeg(60).catch(() => null)
            const ds = this.recordStep(
              this.steps.length + 1,
              `任务异常: ${msg.slice(0, 120)}`,
              [{ name: 'wait', result: '任务异常收尾（错误帧兜底）', error: msg.slice(0, 200) }],
              tab,
              undefined,
              shot || undefined
            )
            this.broadcast({ channel: 'step', step: ds })
          }
        } catch {}
        this.setState({ state: 'error', statusText: `任务异常: ${msg}`, totalMs: this.taskStartedAt ? Date.now() - this.taskStartedAt : undefined })
        this.broadcast({ channel: 'toast', message: `任务异常: ${msg}`, kind: 'error' })
        // 经验负反馈（P1-12）：异常收尾也是「命中经验但没跑成」，相关经验降分才可被淘汰
        try {
          feedbackExperience(this.tabManager.active()?.url || '', task, false)
        } catch {}
      })
      .finally(() => {
        if (this.loopActive === p) this.loopActive = null
        this.telemetry.end({ state: this.state.state, steps: this.steps.length, tokens: this.state.usage })
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

  /**
   * 清空显示（任务终止/完成后手动触发）：时间线步骤、任务记忆、状态回到空闲。
   * 仅空闲态可清（运行中拒绝）；不影响历史记录与经验库。
   */
  clearDisplay(): void {
    if (this.state.state === 'running' || this.state.state === 'paused') {
      throw new Error('任务进行中不能清空，请先停止任务')
    }
    this.steps = []
    this.lastResults = []
    this.plan = []
    this.planIdx = 0
    this.nodeStatuses = []
    this.nodeReasons = []
    this.setState({
      state: 'idle',
      task: '',
      stepCount: 0,
      statusText: '空闲',
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
      memory: {},
      plan: undefined,
      result: undefined
    })
    this.broadcast({ channel: 'steps-clear' })
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
      this.prevExtract = null
      this.failStreakName = ''
      this.failStreakCount = 0
      this.clarifyCount = 0
      this.boostTried = 0
      this.frictionWarns = 0
      this.lastGuidanceText = ''
      this.lastFailureKind = ''
      this.triedList = []
      this.replanCount = 0
      this.replanPending = ''
      this.noProgressSteps = 0
      this.progressAnchorIdx = 0
      this.expertRetriesUsed = 0
      this.expertArmed = false
      this.lastBatchActions = []
      this.zeroDeltaRetries = 0
      this.abortCtrl = new AbortController()
      this.pauseRequested = false
      this.telemetry.start(task, settings.telemetry !== false)
      this.executor.resetWaitState()
      this.executor.onCircuitBreak = (host, url) => {
        // P0-2：host 定位站点 + url 区分同站点页面形态（页面特征）
        this.telemetry.log('circuit_break', this.steps.length + 1, { host, url: (url || '').slice(0, 200) })
      }
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
            this.telemetry.end({ state: this.state.state, steps: this.steps.length, tokens: this.state.usage })
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
    this.setState({ state: 'stopped', statusText: '已停止', totalMs: this.taskStartedAt ? Date.now() - this.taskStartedAt : undefined })
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
    this.telemetry.log('human', this.steps.length + 1, { kind: 'guidance', text: t.slice(0, 100), withImage: !!img })

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

  /** 节点链状态（UI 节点进度条渲染） */
  private planStatus() {
    return {
      nodes: this.plan.map((n, i) => ({
        intent: n.intent,
        expected: n.expected,
        status: this.nodeStatuses[i] || 'pending',
        reason: this.nodeReasons[i],
        fails: i === this.planIdx ? this.nodeFails : undefined
      })),
      current: Math.min(this.planIdx + 1, Math.max(this.plan.length, 1))
    }
  }

  /**
   * 人工批准当前节点通过（人工介入区按钮）：跳过其复核、视为预期已达成并推进到下一节点。
   * 暂停中（如复核多次失败已升级人工）批准即自动继续执行。
   */
  approveNode(): void {
    if (!this.plan.length || this.planIdx >= this.plan.length) {
      throw new Error('没有待批准的节点（任务未在节点链模式或全部节点已通过）')
    }
    const idx = this.planIdx
    const node = this.plan[idx]
    this.nodeStatuses[idx] = 'passed'
    this.nodeReasons[idx] = '人工批准通过（跳过复核）'
    this.planIdx = Math.min(this.planIdx + 1, this.plan.length)
    this.nodeFails = 0
    this.nodeLastFailReason = ''
    const next =
      this.planIdx < this.plan.length
        ? `继续执行节点${this.planIdx + 1}「${this.plan[this.planIdx].intent}」，预期: ${this.plan[this.planIdx].expected}。`
        : '全部节点已完成。'
    if (this.planIdx < this.plan.length) this.nodeStatuses[this.planIdx] = 'active'
    this.lastResults.push(
      `系统提示: 人工已批准节点${idx + 1}「${node.intent}」通过（跳过复核，视为预期已达成）。${next}`
    )
    this.setState({
      plan: this.planStatus(),
      statusText: `人工已批准节点${idx + 1}通过${this.planIdx < this.plan.length ? `，进入节点 ${this.planIdx + 1}` : '，全部节点完成'}`
    })
    // 批准即继续：复核升级人工导致的暂停一并恢复
    if (this.pauseRequested) this.resumeTask()
  }

  /**
   * 计划阶段：把任务分解为「意图 + 预期」的节点链（链式节点执行）。
   * 失败自动重试一次；仍失败不阻塞任务——但必须显式告知（toast + 状态栏），
   * 静默降级会表现为「没出现节点链还自动执行」，用户无从分辨是关了复核还是规划挂了。
   */
  /**
   * 节点链规划（v4.5 接地规划 + PlanValidator）。
   *
   * snap 由调用方在**首次元素提取之后**构造——历史实现把 buildPlan 放在循环第一行、
   * 只喂任务文本，模型写 expected 靠的是先验知识而非观察，导致 expected 与页面实际叫法脱节、
   * 复核必然 uncertain。现在节点基于真实页面元素产出，并由 validatePlan 做四类确定性校验：
   *   C1 check 必填 / C2 check 取值幻觉 / C3 任务实体覆盖 / C4 target 可达性
   * 校验不通过 → 带问题回灌修复一次 → 仍不过则降级为无节点链执行（不阻塞任务）。
   */
  private async buildPlan(
    task: string,
    provider: LlmProvider,
    epoch: number,
    snap?: PlanPageSnapshot
  ): Promise<void> {
    let nodes: PlanNode[] | null = null
    let lastErr = ''
    let lastRaw = ''
    let repairHint = ''
    // 修复循环：最多 3 轮（首次 + 2 次修复）。每轮都过 validatePlan，不合格带问题重问。
    for (let attempt = 0; attempt < 3 && !nodes; attempt++) {
      const repairing = attempt > 0
      try {
        this.setState({
          statusText: repairing ? `节点链校验未通过，重新规划（第 ${attempt} 次）…` : '规划任务节点链…'
        })
        // plain：输出形状是 {nodes}，与 STEP_SCHEMA 不匹配，不能带 step 结构化输出；
        // v4.6 C6：规划预算按模型档位分档（普通模型 1536 / 推理模型 6144——思考计入输出，收紧会截断 JSON）。
        // 预算在**每轮 attempt 重算**：截断自愈升级（escalateBudget）后下一轮自动拿到 6144
        const sPlan = getSettings()
        const planBudget = this.budgetFor('plan', sPlan.model, sPlan)
        const prompt = repairing
          ? `${buildPlanPrompt(task, snap)}\n\n${repairHint}`
          : buildPlanPrompt(task, snap)
        const out = await provider.chat(PLAN_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], this.abortCtrl!.signal, {
          plain: true,
          maxTokens: planBudget
        })
        if (epoch !== this.epoch) return
        this.addUsage(out.usage)
        // v4.6 A2：规划调用分账（此前规划调用不在 llm_call 账里，只能靠 usage 反推）
        this.telemetry.log('llm_call', 0, {
          site: 'plan',
          local: false,
          vision: false,
          planner: false,
          structured: out.structured || 'none',
          input: out.usage.inputTokens,
          output: out.usage.outputTokens,
          cachedIn: out.usage.cachedInputTokens
        })
        lastRaw = out.text
        // v4.6 C6 自愈（规划路径）：输出吃满预算 = 思考被截断（未知推理模型，正则漏判）——
        // 立即把该模型升级为 legacy 预算（会话级），下一轮 attempt 用 6144 重试。
        // 此前只有 step 路径有自愈，规划 3 连败直接退化逐步执行（MiniMax-M3.1 实测踩中）
        if (out.usage.outputTokens >= planBudget) {
          escalateBudget(sPlan.model)
          this.telemetry.log('failure', 0, {
            kind: 'budget_escalate',
            site: 'plan',
            model: sPlan.model,
            budget: planBudget,
            out: out.usage.outputTokens
          })
          repairHint = `# 上一轮输出在 ${planBudget} token 预算处被截断（推理思考吃满了预算）。系统已放宽预算。请直接输出节点 JSON（先想清楚再输出，压缩思考长度），禁止 markdown 代码块。`
          continue
        }
        const parsed = parsePlan(out.text)
        if (!parsed) {
          lastErr = '模型输出不是合法的节点 JSON'
          repairHint = `# 上一轮输出无法解析为节点 JSON（${lastErr}）。只输出 {"nodes":[...]}，禁止 markdown 代码块与多余文字。`
          continue
        }
        // PlanValidator：确定性问题在这一层拦下，别留到执行阶段靠重试
        const v = validatePlan({ nodes: parsed, snap, task })
        if (!v.ok) {
          this.telemetry.log('failure', 0, { kind: 'plan_invalid', issues: v.issues.length })
          repairHint = renderPlanIssues(v.issues)
          lastErr = `计划校验未通过（${v.issues.length} 项）`
          continue
        }
        nodes = parsed
      } catch (e: any) {
        // 用户停止/暂停打断的异常不算规划失败，直接让位给 checkpoint 处理
        if (this.abortCtrl?.signal.aborted) return
        lastErr = String(e?.message || e).slice(0, 80)
        repairHint = `# 上一轮调用失败（${lastErr}）。请重新输出完整的节点 JSON。`
      }
    }
    if (epoch !== this.epoch) return
    if (!nodes || !nodes.length) {
      // 规划失败此前无任何 trace 事件，只能靠 usage 反推；记 lastErr + 原始输出片段便于回溯
      this.telemetry.log('failure', 0, { kind: 'plan_fail', err: lastErr, raw: lastRaw.slice(0, 200) })
      this.broadcast({
        channel: 'toast',
        message: `节点链规划失败（${lastErr || '未知原因'}），本次退化为逐步执行、不做节点复核`,
        kind: 'info'
      })
      this.setState({ statusText: `节点链规划失败（${lastErr || '未知原因'}），退化为逐步执行` })
      return
    }
    this.plan = nodes
    this.planIdx = 0
    this.nodeStatuses = nodes.map((_, i) => (i === 0 ? 'active' : 'pending'))
    this.nodeReasons = nodes.map(() => undefined)
    this.setState({ plan: this.planStatus() })
    this.broadcast({ channel: 'toast', message: `任务已分解为 ${nodes.length} 个节点，逐步复核执行`, kind: 'info' })
  }

  /**
   * 节点复核结果处理：通过 → 推进节点；未通过 → 视觉优先自愈重试，同错/多次失败升级人工介入。
   * 返回 true=当前节点已过（可推进/收尾），false=当前节点未过（不应收尾）。
   */
  private handleNodeVerdict(verdict: Verdict, stepN: number): boolean {
    const idx = this.planIdx
    const node = this.plan[idx]
    const label = `节点${idx + 1}「${node.intent}」`
    if (verdict.passed) {
      this.nodeStatuses[idx] = 'passed'
      this.nodeReasons[idx] = verdict.source === 'skip' ? `复核跳过（${verdict.reason}）` : undefined
      this.planIdx = Math.min(this.planIdx + 1, this.plan.length)
      this.nodeFails = 0
      this.nodeLastFailReason = ''
      if (this.planIdx < this.plan.length) {
        this.nodeStatuses[this.planIdx] = 'active'
        const next = this.plan[this.planIdx]
        this.lastResults.push(
          `系统提示: ${label}复核通过（${verdict.source}: ${verdict.reason}）。进入节点${this.planIdx + 1}「${next.intent}」，预期: ${next.expected}。本节点预期达成后在输出 JSON 里加 "node_done":true。`
        )
        this.setState({
          plan: this.planStatus(),
          statusText: `第 ${stepN} 步：${label} 复核通过，进入节点 ${this.planIdx + 1}`
        })
      } else {
        this.lastResults.push(`系统提示: ${label}复核通过（${verdict.source}: ${verdict.reason}），全部节点已完成。`)
        this.setState({ plan: this.planStatus(), statusText: `第 ${stepN} 步：${label} 复核通过，全部节点完成` })
      }
      return true
    }
    // —— 复核未通过：自愈重试（视觉优先） ——
    this.nodeFails++
    this.nodeReasons[idx] = verdict.reason
    const sameReason = !!verdict.reason && verdict.reason === this.nodeLastFailReason
    this.nodeLastFailReason = verdict.reason
    // T9 触发条件（P0-5）：节点连续复核失败 2 次 → 待重规划（开关/上限由 loop 统一判）
    if (this.nodeFails >= 2 && !this.replanPending) {
      this.replanPending = `节点${idx + 1}「${node.intent}」连续复核失败 ${this.nodeFails} 次`
    }
    if (this.nodeFails >= 3 || (sameReason && this.nodeFails >= 2)) {
      // 同样的问题反复失败：不再盲目重试，升级人工介入
      this.nodeStatuses[idx] = 'escalated'
      this.setState({
        plan: this.planStatus(),
        state: 'paused',
        statusText: `${label} 复核未通过：${verdict.reason}。请人工确认/指路，或批准本节点通过后点「继续」`
      })
      this.broadcast({
        channel: 'toast',
        message: `${label} 多次复核未通过：${verdict.reason}。已暂停等待人工介入（可在人工介入区批准本节点通过）`,
        kind: 'captcha'
      })
      try {
        this.tabManager.notifyHuman(`${label} 复核未通过`, `${verdict.reason}。请人工确认/修正后点击「继续」。`)
      } catch {}
      this.pauseRequested = true
      this.nodeFails = 0
      return false
    }
    this.nodeStatuses[idx] = 'failed'
    // 自愈优先视觉判断：临时开启视觉兜底（截图 + 看图定位/坐标点击）
    this.visionFallbackLeft = Math.max(this.visionFallbackLeft, 2)
    this.lastResults.push(
      `系统提示: ${label} 复核未通过（${verdict.reason}）。预期「${node.expected}」尚未达成：请重新检查最新页面并修正本节点（已临时开启视觉兜底，可结合截图看图定位）；预期达成前不要输出 node_done，也不要跳到后面的节点。`
    )
    this.setState({
      plan: this.planStatus(),
      statusText: `第 ${stepN} 步：${label} 复核未通过：${verdict.reason}，自愈重试（${this.nodeFails}/3）`
    })
    return false
  }

  /**
   * S2 分类自愈策略：按诊断结果注入提示/开启兜底/升级人工。
   * 每类只做一件事，互不越权；hint 直接进下一步提示词（模型可执行的人话）。
   */
  private async applyDiagnosis(
    d: Diagnosis,
    executed: AgentAction[],
    extract: ExtractResult,
    task: string,
    stepN: number,
    fallbackAllowed: boolean
  ): Promise<void> {
    switch (d.kind) {
      case 'locate': {
        // 原 locateFailStreak 联动：连续定位失败 → 视觉兜底（截图看图定位）
        this.locateFailStreak++
        if (this.locateFailStreak >= 2 && fallbackAllowed && this.visionFallbackLeft === 0) {
          this.visionFallbackLeft = 3
          this.locateFailStreak = 0
          this.lastResults.push(
            '系统提示: 连续定位不到目标元素，已临时开启「视觉兜底」——接下来几步会附带页面截图，你可以直接用 {"name":"click_xy","x":500,"y":300} 按截图上的归一化坐标（0~1000）点击目标；能找到元素编号时仍优先用 click index。'
          )
          this.setState({ statusText: `第 ${stepN} 步：元素定位失败，已开启视觉兜底（截图定位）` })
        }
        this.lastResults.push(d.hint)
        break
      }
      case 'semantic': {
        // 重排提示：列出与任务最相关的 Top-5 候选，帮模型换对输入框
        const top = extract.candidates
          .map((c, i) => ({
            i,
            c,
            s: scoreCandidate({ text: c.text, extra: c.extra, role: c.role, tag: c.tag }, task).score
          }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 5)
        const list = top.map((t) => `[${t.i}] ${(t.c.text || t.c.extra || '').slice(0, 20)}(${Math.round(t.s * 100)}%)`).join(' ')
        this.lastResults.push(`${d.hint} 与任务最相关的候选: ${list || '（无）'}`)
        this.setState({ statusText: `第 ${stepN} 步：疑似填错字段，已提示改选语义匹配的输入框` })
        break
      }
      case 'page_changed':
      case 'data_missing':
        this.lastResults.push(d.hint)
        break
      case 'loop': {
        // 同一动作反复失败：不再盲目重试，升级人工介入
        this.locateFailStreak = 0
        this.failStreakCount = 0
        this.setState({ state: 'paused', statusText: `动作反复失败已暂停：${d.hint}` })
        this.broadcast({
          channel: 'toast',
          message: `动作「${executed[0]?.name || ''}」连续失败，已暂停等待人工介入`,
          kind: 'captcha'
        })
        try {
          this.tabManager.notifyHuman('动作反复失败', '同一操作连续失败 3 次以上，请人工确认/指路后点击「继续」。')
        } catch {}
        this.pauseRequested = true
        break
      }
      default:
        break
    }
  }

  /** S2 步数耗尽的结构化诊断：卡点节点 + 最近失败类型 + 可执行建议 */
  private exhaustedDiagnosis(maxSteps: number): string {
    const lines: string[] = [`已达最大步数 ${maxSteps}，任务未完成。诊断:`]
    if (this.plan.length && this.planIdx < this.plan.length) {
      const node = this.plan[Math.min(this.planIdx, this.plan.length - 1)]
      lines.push(`- 卡在节点${this.planIdx + 1}「${node.intent}」（预期: ${node.expected}）`)
    }
    // 最近 5 步的失败动作归因
    const recent = this.steps.slice(-5).filter((s) => s.actions.some((a) => a.error))
    if (recent.length) {
      const kinds = recent
        .map((s) => {
          const bad = s.actions.find((a) => a.error)!
          const kind = /疑似填错字段/.test(bad.error || '')
            ? 'semantic（疑似填错字段）'
            : /已失效|不可见|找不到|无法定位/.test(bad.error || '')
              ? 'locate（定位失败）'
              : '其他错误'
          return `第${s.n}步 ${bad.name}: ${kind}`
        })
        .join('；')
      lines.push(`- 最后 ${recent.length} 步持续失败：${kinds}`)
    } else {
      lines.push('- 最近步骤无显式失败（可能是原地打转或目标始终未达成）')
    }
    lines.push('- 建议：检查目标页面字段命名是否与任务描述一致（可在设置中开启/调整语义匹配）、补充该站点经验库，或把任务拆小后重试。')
    lines.push('如需继续，可重新发起任务。')
    return lines.join('\n')
  }

  /* —— T8 失败性质二分（P1-10）：方式失败进「禁止重复」清单；业务失败可修正后重试，不进清单 —— */
  private isMethodFailure(err: string): boolean {
    // 业务失败：提交后服务端报错 / wait_for 网络 4xx/5xx / 表单校验 —— 换数据换表单可修正
    if (/接口响应异常|HTTP\s[45]\d\d|校验错误|服务端|提交失败|限流|稍后再试/.test(err)) return false
    // 方式失败：元素失效/未命中/遮挡/禁用/坐标命中不一致/同方式重复 —— 必须换方式
    return /已失效|不可见|找不到|无法定位|遮挡|禁用|坐标命中|已两次|换一种/.test(err)
  }

  /** T8 记录一次失败尝试（每目标最近 3 条、全局封顶 20 条） */
  private addTried(sig: string, method: string, reason: string): void {
    this.triedList.push({ sig, method, reason: reason.slice(0, 80) })
    const mine = this.triedList.filter((t) => t.sig === sig)
    if (mine.length > 3) {
      const idx = this.triedList.indexOf(mine[0])
      this.triedList.splice(idx, 1)
    }
    while (this.triedList.length > 20) this.triedList.shift()
  }

  /** T8 同签名同方式已失败次数（≥2 时执行前拦截第 3 次重复） */
  private triedCount(sig: string, method: string): number {
    return this.triedList.filter((t) => t.sig === sig && t.method === method).length
  }

  /** T8 清单注入行（动态后缀区；本地 0.5B 链路不注入——横切约束 1） */
  private triedPromptLines(): string[] {
    return this.triedList.slice(-8).map((t) => `- 目标「${t.sig.split('|')[1] || '?'}」${t.method} 方式失败: ${t.reason}`)
  }

  /**
   * T7 动作后核验（W10，P1-8）：delta 比对复用「下一步开头的 extract 快照」与上一步快照（零额外 CDP）。
   * 结构信号优先（URL/标题/新列表行/弹窗）；仅「导航类/提交类 click + 全零 delta」给强提示，
   * hover/toggle/toast 类不给「无变化」强提示（防假阴性误报）；候选数 ±30% 只记 telemetry。
   */
  private deltaVerify(prevActions: AgentAction[], prev: ExtractResult | null, next: ExtractResult): string | undefined {
    if (!prev) return undefined
    // canvas 文档编辑器（WPS 等）：正文变化不反映到 DOM/候选列表——「无变化」提示系统性误报，
    // 会诱导模型重复写入（截图里的商品名称写两遍即此根因）。视觉模式看截图自核，文本 delta 全部抑制
    if (next.canvasEditor) return undefined
    const urlChanged = (prev.url || '') !== (next.url || '')
    const titleChanged = (prev.title || '') !== (next.title || '')
    const prevTexts = new Set(prev.candidates.map((c) => c.text).filter(Boolean))
    const newTexts = next.candidates.map((c) => c.text).filter((t) => t && !prevTexts.has(t))
    const countDelta = next.candidates.length - prev.candidates.length
    const structural = urlChanged || titleChanged || newTexts.length > 0
    // 候选数 ±30% 先只记 telemetry，跑一周分布再定阈值（P1-8）
    if (prev.candidates.length > 0 && Math.abs(countDelta) / prev.candidates.length > 0.3) {
      this.telemetry.log('action_verify', this.steps.length + 1, {
        kind: 'count_delta',
        from: prev.candidates.length,
        to: next.candidates.length
      })
    }
    if (structural) {
      this.telemetry.log('action_verify', this.steps.length + 1, {
        kind: 'change',
        urlChanged,
        titleChanged,
        newTexts: newTexts.length
      })
      return undefined // 有结构变化 = 正常，不打扰
    }
    // 全零 delta：按上一批动作类型分流（P1-8）。
    // 提交类 click 用 executor 回填的 submitish 标志判定（回读 a.result 文案恒不含提交关键词，正则不可达）
    const navOrSubmit = prevActions.some(
      (a) =>
        a.name === 'goto' ||
        a.name === 'back' ||
        a.name === 'forward' ||
        ((a.name === 'click' || a.name === 'click_xy') && a.submitish === true)
    )
    const quietActions = prevActions.every((a) => ['hover', 'wait', 'save', 'recall', 'read_content', 'extract_images'].includes(a.name))
    this.telemetry.log('action_verify', this.steps.length + 1, {
      kind: 'no_change',
      actions: prevActions.map((a) => a.name).join(',')
    })
    if (navOrSubmit) {
      return '上一步的导航/提交操作后页面无任何变化（URL、标题、元素均未变），操作可能未生效或被页面拦截：请先确认页面真实状态再继续，不要当作已成功。'
    }
    if (quietActions) return undefined // hover/等待类本来就可能无变化，不给提示（防假阴性误报）
    // v4.5 P1-4/P2-5：零 delta 的「点击未生效」给**可用信息**而不是一句套话。
    // 历史文案只说「检查是否生效」，模型缺的恰恰是「我点的到底是什么、这一片还有哪些可点的」——
    // 回传候选清单 + 状态复位提示，让下一步能换目标而不是换编号重试。
    const acted = prevActions.filter((a) => a.name === 'click' || a.name === 'click_xy')
    if (acted.length === 1) {
      const act = acted[0]
      const idx = act.index ?? -1
      const orig = prev.candidates[idx]
      const area = orig
        ? prev.candidates
            .filter(
              (c) =>
                c.role === orig.role &&
                Math.abs(c.rect.x - orig.rect.x) < 220 &&
                Math.abs(c.rect.y - orig.rect.y) < 90 &&
                c !== orig
            )
            .slice(0, 4)
            .map((c) => `[${prev.candidates.indexOf(c)}]"${c.text || c.role}"${c.anchor ? `(行:${c.anchor})` : ''}`)
        : []
      const target = orig ? `你点的是「${(orig.text || orig.role || '').slice(0, 20)}」` : '你点的元素'
      return (
        `⚠ 点击未生效（${target}）：页面 URL/标题/元素列表在操作后完全没变化，说明点下去没有任何反馈。\n` +
        `可能原因与对策：① 目标不是可点击控件或被透明层拦截；② 该操作只改变内部状态不反映到列表；③ 选错了行/控件。\n` +
        `建议：不要换个编号重复点同一个位置。先看同一区域还有哪些可点目标${area.length ? `：${area.join(' ')}` : ''}；` +
        `若页面有残留弹窗/遮罩/滚动偏移，系统已尝试自动复位，仍不行就用 clarify 问用户要准确位置。`
      )
    }
    return '上一步操作后页面无明显变化，如预期应有变化请检查操作是否生效。'
  }

  /**
   * v4.5 P2-3 状态复位探针（recoverPage）：在坏状态上叠加重试只会更糟。
   * 表单填了一半、弹窗挡着、页面滚到一半——这些都会让「同一个动作再试一次」必然失败。
   * 一次 CDP evaluate 关残留遮罩 + 滚回顶部 + 清 file input 残留，约 200ms。
   * 只关**不含任务关键词**的 role=dialog 遮罩：任务本身需要的中间态弹窗绝不能被关掉。
   */
  private async recoverPage(task: string): Promise<string> {
    const t = this.tabManager.active()
    if (!t) return ''
    try {
      const r = await t.cdp.evaluate<{ closed: number; scrolled: boolean }>(RECOVER_PAGE_FN, [task.slice(0, 200)])
      if (r?.closed || r?.scrolled) {
        this.telemetry.log('action_verify', this.steps.length + 1, { kind: 'recover_page', ...r })
      }
      return r?.closed ? `已自动关闭 ${r.closed} 个残留弹窗/遮罩并复位页面滚动位置，请基于复位后的页面重新判断` : ''
    } catch {
      return ''
    }
  }

  /** T9 快照摘要（重规划上下文继承用） */
  private snapshotSummary(extract: ExtractResult): string {
    const tops = extract.candidates
      .slice(0, 12)
      .map((c, i) => `[${i}]${c.text || c.extra || c.role}`)
      .join(' ')
    return `标题: ${extract.title.slice(0, 60)}\nURL: ${(extract.url || '').slice(0, 100)}\n元素摘要: ${tops}`
  }

  /**
   * T9 动态重规划（W8，P0-5 全量修正）：
   * - 上下文继承：原任务 + 已完成/待验证节点 + 当前失败节点 + 失败归因 + tried 清单 + 快照摘要；
   * - 已完成节点可标「需重做」：新计划允许把节点插回队首（治登录被踢后冻结死锁）；
   * - 调用走 planner（T10；未配置回落主模型）；上限 2 次；时间线明示。
   */
  private async doReplan(
    task: string,
    provider: LlmProvider,
    plannerProvider: LlmProvider | null,
    extract: ExtractResult,
    trigger: string,
    stepN: number,
    epoch: number
  ): Promise<void> {
    const useProvider = plannerProvider || provider
    const cur = this.plan[Math.min(this.planIdx, this.plan.length - 1)]
    // v4.5 P2-6：把上一版计划里已生效的 target/check 作为「可沿用的锚」交给重规划器，
    // 并附当前页面真实元素摘要（接地重规划）——否则新计划多半又不给 check、target 又是想象出来的，
    // 重规划质量低于首规划等于白重规划。
    const anchors = this.plan
      .map((n) => ({ intent: n.intent, target: n.target, check: n.check }))
      .filter((a) => a.target || a.check)
    const prompt = buildReplanPrompt({
      task,
      doneNodes: this.plan.slice(0, this.planIdx).map((n) => ({ intent: n.intent, expected: n.expected })),
      curNode: cur ? { intent: cur.intent, expected: cur.expected, failReason: this.nodeLastFailReason || trigger } : undefined,
      triedList: this.triedPromptLines(),
      snapshotSummary: this.snapshotSummary(extract),
      anchors,
      pageSnapshot: buildPlanSnapshot(extract),
      // v4.6 B1：附最近一次动作后核验摘要——重规划器要知道「刚才那下页面有什么反应」，不只是「失败了」
      delta: this.lastDeltaHint || undefined
    })
    this.setState({ statusText: `第 ${stepN} 步：执行受阻（${trigger}），重规划剩余节点…` })
    const sReplan = getSettings()
    this.telemetry.log('replan', stepN, {
      trigger,
      count: this.replanCount + 1,
      forceL2: true,
      tuned: sReplan.replanTune !== false
    })
    let nodes: PlanNode[] | null = null
    let repairHint = ''
    // 与 buildPlan 同一套校验：重规划产出的计划也必须过 PlanValidator，
    // 否则「换了个花样的坏计划」会直接顶替原计划
    const pageSnap = buildPlanSnapshot(extract)
    for (let attempt = 0; attempt < 3 && !nodes; attempt++) {
      try {
        // plain + 大 maxTokens：重规划输出 {nodes}，与 step 结构化不匹配且推理模型思考需余量（同 buildPlan）
        // v4.6 C6：按 planner/主模型各自的档位分预算；逐轮重算（截断升级后下一轮自动放宽）
        const replanModel = (plannerProvider ? sReplan.planner?.model : undefined) || sReplan.model
        const replanBudget = this.budgetFor('replan', replanModel, sReplan)
        const out = await useProvider.chat(
          REPLAN_SYSTEM_PROMPT,
          [{ role: 'user', content: attempt > 0 ? `${prompt}\n\n${repairHint}` : prompt }],
          this.abortCtrl!.signal,
          {
            plain: true,
            maxTokens: replanBudget
          }
        )
        if (epoch !== this.epoch) return
        // v4.6 C6 自愈（重规划路径）：输出吃满预算 = 思考被截断 → 会话级升级该模型预算
        if (out.usage.outputTokens >= replanBudget) {
          escalateBudget(replanModel)
          this.telemetry.log('failure', stepN, {
            kind: 'budget_escalate',
            site: 'replan',
            model: replanModel,
            budget: replanBudget,
            out: out.usage.outputTokens
          })
          repairHint = `# 上一轮输出在 ${replanBudget} token 预算处被截断（推理思考吃满了预算）。系统已放宽预算。请直接输出节点 JSON，禁止 markdown 代码块。`
          continue
        }
        // T10 token 分列：配置了独立 planner 时，重规划调用归入 planner 用量（telemetry + UI 分列）
        if (plannerProvider) {
          this.plannerUsage.inputTokens += out.usage.inputTokens
          this.plannerUsage.outputTokens += out.usage.outputTokens
        }
        // v4.6 A2：重规划调用分账（此前只在 planner 分支记录，主模型重规划不入账）
        this.telemetry.log('llm_call', stepN, {
          site: 'replan',
          local: false,
          vision: false,
          planner: !!plannerProvider,
          kind: 'replan',
          input: out.usage.inputTokens,
          output: out.usage.outputTokens,
          cachedIn: out.usage.cachedInputTokens
        })
        this.addUsage(out.usage)
        const parsed = parsePlan(out.text)
        if (!parsed) {
          repairHint = '# 上一轮输出无法解析为节点 JSON。只输出 {"nodes":[...]}，禁止 markdown 代码块与多余文字。'
          continue
        }
        const v = validatePlan({ nodes: parsed, snap: pageSnap, task })
        if (!v.ok) {
          this.telemetry.log('failure', stepN, { kind: 'replan_invalid', issues: v.issues.length })
          repairHint = renderPlanIssues(v.issues)
          continue
        }
        nodes = parsed
      } catch (e) {
        if (this.abortCtrl?.signal.aborted) return
      }
    }
    this.replanCount++
    if (!nodes || !nodes.length) {
      this.broadcast({ channel: 'toast', message: `重规划失败（模型输出不可解析），沿用原计划继续`, kind: 'info' })
      return
    }
    // 新计划落地：允许包含「需重做」的已完成节点（插回队首），全部重置为待执行
    this.plan = nodes
    this.planIdx = 0
    this.nodeStatuses = nodes.map((_, i) => (i === 0 ? 'active' : 'pending'))
    this.nodeReasons = nodes.map(() => undefined)
    this.nodeFails = 0
    this.nodeLastFailReason = ''
    this.doneHeld = 0
    this.noProgressSteps = 0
    this.progressAnchorIdx = 0
    this.replanPending = ''
    const redoNote = `本计划是第 ${this.replanCount} 次重规划产物（触发: ${trigger}）。必须以当前页面真实状态为准执行——之前完成过的步骤可能已失效，计划中重新出现的节点就是需要重做的，不要跳过。本任务收尾前会经云端 L2 强制复核。`
    this.lastResults.push(`系统提示: ${redoNote}`)
    this.broadcast({
      channel: 'toast',
      message: `已重规划为 ${nodes.length} 个节点（第 ${this.replanCount} 次；收尾将强制 L2 复核）`,
      kind: 'info'
    })
    // 时间线持久条目：重规划是任务关键事件，toast 会消失、steps 里应可回溯（P1 复核修订）
    try {
      const t = this.tabManager.active()
      if (t) {
        const ds = this.recordStep(
          stepN,
          `🔄 已重规划为 ${nodes.length} 个节点（第 ${this.replanCount} 次；触发: ${trigger}；收尾将强制云端 L2 复核）`,
          [{ name: 'wait', result: '重规划完成，按新计划继续执行' }],
          t
        )
        this.broadcast({ channel: 'step', step: ds })
      }
    } catch {}
    this.setState({ plan: this.planStatus(), statusText: `第 ${stepN} 步：重规划完成（${nodes.length} 节点），继续执行` })
  }

  private async loop(task: string, provider: LlmProvider, settings: Settings, epoch: number): Promise<void> {
    let consecutiveParseFail = 0
    let planAttempted = false
    let skipCaptchaCheckOnce = false
    // T10 planner（W9）：只用于决策点（重规划/strict 复核 L2/专家重试），绝不参与逐步执行
    let plannerProvider: LlmProvider | null = null
    if (hasPlannerConfig(settings)) {
      try {
        plannerProvider = createPlannerProvider(settings)
      } catch {
        plannerProvider = null
      }
    }
    // 视觉模式：设置开启且该模型未被确认"不支持图片"；任务内降级标志（模型拒图后本任务不再发图）
    const visionKey = `${settings.baseURL}|${settings.model}`
    let visionDegraded = false
    // 混合模式（本地快速决策）：失败后冷却若干步；本地推理过慢则本任务禁用
    let localCooldown = 0
    let localDisabled = false
    // S6 语义初筛同样有任务级预算：本地小模型单次超预算（机器过慢）时本任务停用，
    // 宁可多花云端 token 也不再每步空等一次慢推理（推理已在独立进程，这里只保时延）。
    // P0-4：另有软预算 1.2s 计数熔断（连续 2 次超时即停，见 prescreen 调用处）
    let prescreenDisabled = false
    let prescreenTimeouts = 0

    while (true) {
      // 暂停等待 / 停止判定（返回 false 则任务结束；epoch 失配=已被新运行取代）
      if (!(await this.checkpoint(epoch))) return
      // abort signal 一律在使用点实时读 this.abortCtrl!.signal——
      // 暂停恢复会中途重建 controller，迭代开头的局部快照会变陈旧（已 abort），
      // 导致后续模型调用/动作批被误中止白跑一轮（复核 P1-7）

      // 0. 模型步数（人工指导不算步数预算）；测试模式放宽（一个测试步骤可能消耗多个模型步）
      const stepN = this.steps.filter((s) => !s.userGuidance).length + 1
      const maxSteps = this.testCtx
        ? Math.max(settings.maxSteps, this.testCtx.tc.steps.length * 8 + 6)
        : settings.maxSteps
      if (stepN > maxSteps) {
        // S2 步数耗尽诊断化：不再一句"已达最大步数"，给出卡点与失败归因
        this.telemetry.log('failure', stepN, { kind: 'exhausted', strategy: 'abort' })
        this.telemetry.end({ state: 'exhausted', steps: this.steps.length, tokens: this.state.usage })
        // 经验负反馈（P1-12）：命中本站经验却没跑成 → 相关经验降分，错误/陈旧经验可被淘汰
        try {
          feedbackExperience(this.tabManager.active()?.url || '', task, false)
        } catch {}
        const diagText = this.exhaustedDiagnosis(maxSteps)
        this.setState({
          state: 'done',
          statusText: `已达到最大步数 ${maxSteps}，任务结束`,
          result: diagText,
          totalMs: this.taskStartedAt ? Date.now() - this.taskStartedAt : undefined
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
      // v4.1 非预期跳转检测：本步开始时的页面 URL（批后对比用；tab.url 会随导航实时更新，须值拷贝）
      const stepStartUrl = tab.url || ''

      // 0.5 登录态刷新（测试模式 + 开启复用；一次轻量探针，约几十毫秒）
      if (this.testCtx) await this.refreshLoginState()

      this.setState({ statusText: `第 ${stepN} 步：提取页面元素…` })

      // 视觉开关提前判定：需要截图时与元素提取并行（省一次 CDP 串行往返）
      const visionActive = settings.vision && !visionDegraded && !visionUnsupported.has(visionKey)
      const fallbackAllowed = settings.visionFallback !== false && !visionDegraded && !visionUnsupported.has(visionKey)
      const visionForced = fallbackAllowed && this.visionFallbackLeft > 0
      if (this.visionFallbackLeft > 0) this.visionFallbackLeft--
      const shotWanted = visionActive || visionForced

      // 1. 提取当前页签元素（T3 并行化：extract / 截图 / AX Tree 同一 Promise.all——
      //    fetchAxTree 与 extract/截图并行，砍掉 AX 的串行往返）。
      //    S1：带 task 做语义重排（语义相关元素提前，重排在快照落盘前完成——编号即最终编号）
      let extract: ExtractResult
      let visionShot: string | null = null
      const wantSemantic = settings.semanticRecall !== false && !!task
      // v4.6 A3/B3：本步页面指纹与「页面有推进」判定（观测段结束后写入 lastPageHash）
      let curPageHash = ''
      let pageAdvanced = false
      const timings: StepTimings = {}
      const tExtract0 = Date.now()
      try {
        const axPromise =
          settings.axTree !== false
            ? fetchAxTree(tab.cdp, 150).then((ax) => {
                timings.axMs = Date.now() - tExtract0
                return ax
              })
              .catch(() => null)
            : Promise.resolve(null)
        const shotPromise = shotWanted
          ? tab.cdp
              .screenshotJpeg(70)
              .then((s) => {
                timings.shotMs = Date.now() - tExtract0
                return s
              })
              .catch(() => null)
          : Promise.resolve(null)
        const [ex, shot, ax] = await Promise.all([
          this.executor.extract(tab, { task: wantSemantic ? task : undefined }),
          shotPromise,
          axPromise
        ])
        extract = ex
        visionShot = shot
        timings.extractMs = Date.now() - tExtract0
        // S3 AX Tree 并联：浏览器引擎计算的 role/name 叠加进文本线索不足的候选（失败静默降级）
        // P0-2（v4 方案 S2）：OCR 增强不再串行阻塞——与 AX 叠加/后续准备并行跑，软预算 2.5s 到点放弃；
        // 产出的是图标候选的文本补充，晚到就不用（下一步自然会再补），绝不拖慢决策链。
        // 关闭/超时零开销；整页 OCR 兜底（ocrWanted 路径）不受影响
        const ocrEnhance =
          settings.ocrEnhance !== false && this.ocrEnhancer
            ? Promise.race([
                this.ocrEnhancer(extract, null).catch(() => extract),
                new Promise<ExtractResult>((r) => setTimeout(() => r(extract), 2500).unref?.())
              ])
            : Promise.resolve(extract)
        if (ax) {
          try {
            const axHits = annotateWithAx(extract, ax)
            this.telemetry.log('extract', stepN, { ax: ax.length, axHits })
          } catch {}
        }
        extract = await ocrEnhance
      } catch (e: any) {
        throw new Error(`页面元素提取失败: ${e?.message || e}（页面可能在加载中，稍后重试）`)
      }

      // S1 扩展提取：任务关键词一个都没命中且页面确实被截断 → 提高上限重提一次
      if (
        wantSemantic &&
        settings.boostedExtract !== false &&
        this.boostTried < 3 &&
        extract.totalFound > extract.candidates.length &&
        !this.executor.taskHitsCandidate(extract, task)
      ) {
        this.boostTried++
        try {
          extract = await this.executor.extractBoosted(tab, task, 160)
          this.telemetry.log('extract', stepN, { boosted: true, candidates: extract.candidates.length })
        } catch {}
      }

      // v4.6 A3/B3：页面指纹（extract 埋点 + 免观测降级判定基础）。
      // pageAdvanced 在更新 lastPageHash **之前**判定：本步指纹 ≠ 上一步指纹 = 页面有推进
      curPageHash = pageHashOf(extract)
      pageAdvanced = curPageHash !== this.lastPageHash
      this.telemetry.log('extract', stepN, {
        candidates: extract.candidates.length,
        totalFound: extract.totalFound,
        truncated: extract.totalFound > extract.candidates.length, // 关键指标：目标可能被截断
        pageHash: curPageHash
      })

      // 0.5 节点链规划（v4.5 接地规划）：放在**首次提取之后**——规划器要基于真实页面元素
      // 产出节点的 target/check，而不是只看任务文本凭空想象字段名。复用上面同一次 extract，
      // 零额外 CDP 往返。规划不再阻塞首动作的快照准备。
      if (!this.testCtx && (settings.verifyMode || 'fast') !== 'off' && !planAttempted) {
        planAttempted = true
        await this.buildPlan(task, provider, epoch, buildPlanSnapshot(extract))
        if (!(await this.checkpoint(epoch))) return
      }
      // v4.5：定位失败路径上的重提取要带 task 做语义重排（此前不带，候选池质量低于正常步骤）
      this.executor.setRelocateTask(task)
      // T7 动作后核验（W10）：delta 比对复用本步开头的 extract 快照与上一步快照（零额外 CDP），
      // 反馈文案注入动态后缀区（横切约束 1）
      let deltaHint =
        settings.actionVerify !== false && this.lastBatchActions.length
          ? this.deltaVerify(this.lastBatchActions, this.prevExtract, extract)
          : undefined
      // v4.4 L5 点击无效果熔断重试（保守版）：上一批=单个「非变更类 click」且零 delta（点了
      // 没反应，多半没送达/目标瞬态）→ 在新快照里按 文本+行标识 唯一重定位同一目标，重放一次
      // 点击（走 executor 全量定位链与命中校验）。硬约束：写操作/开关类/变更类文案绝不自动
      // 重试（防双击双花）；目标重定位不唯一不重试；每任务最多 2 次；重试后仍无变化升级强提示。
      if (deltaHint && this.lastBatchActions.length === 1) {
        const act = this.lastBatchActions[0]
        const origIdx = act.index ?? -1
        const orig = this.prevExtract?.candidates[origIdx]
        const label = orig ? `${orig.text || ''} ${orig.extra || ''} ${orig.anchor || ''}` : ''
        const mutating =
          act.submitish === true ||
          /添加|新增|新建|删除|移除|清空|重置|保存|提交|支付|购买|下单|发布|上传|发送|加入|收藏|关注|点赞|充值|导入/.test(
            label
          ) ||
          /复选框|单选框|switch|checkbox|radio|toggle/i.test(`${orig?.role || ''} ${orig?.tag || ''}`)
        const retryable =
          act.name === 'click' &&
          act.index != null &&
          !!orig &&
          !mutating &&
          !act.error &&
          this.zeroDeltaRetries < 2
        if (retryable) {
          const hits = extract.candidates
            .map((c, i) => ({ c, i }))
            .filter(
              ({ c }) =>
                c.text === orig!.text &&
                (!orig!.anchor || c.anchor === orig!.anchor) &&
                (c.tag === orig!.tag || c.role === orig!.role)
            )
          if (hits.length === 1) {
            this.zeroDeltaRetries++
            this.telemetry.log('action_verify', stepN, {
              kind: 'zero_delta_retry',
              text: (orig!.text || '').slice(0, 20),
              to: hits[0].i
            })
            try {
              await this.executor.executeBatch([{ name: 'click', index: hits[0].i, expect_text: act.expect_text }], {
                memory: this.state.memory,
                signal: this.abortCtrl!.signal,
                settings,
                task: this.testCtx ? undefined : task,
                url: tab.url
              })
              // 重试后重提取复核：有变化=已生效（deltaHint 清空）；仍无变化=升级强提示
              extract = await this.executor.extract(tab, { task: wantSemantic ? task : undefined })
              const hint2 =
                settings.actionVerify !== false ? this.deltaVerify(this.lastBatchActions, this.prevExtract, extract) : undefined
              deltaHint = hint2
                ? `${hint2}（系统已自动重试点击一次仍无变化，已停止自动重试：请换一种方式操作该目标，或确认目标是否需要先展开/滚动到可见）`
                : undefined
            } catch (e: any) {
              deltaHint = `${deltaHint}（自动重试失败：${(e?.message || e).slice(0, 60)}）`
            }
          }
        }
      }
      this.prevExtract = extract

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

      // 2. 验证码 / 登录检测 / 风控限流（block 级暂停交人工；warn 级指数退避放慢）
      if (!skipCaptchaCheckOnce) {
        try {
          const fr = await tab.cdp.evaluate<{
            urlHit: boolean
            hitSel: string[]
            textHit: boolean
            loginHint: boolean
            warnHit: boolean
            url: string
          }>(DETECT_FRICTION_FN, [])
          const isCaptcha = fr.hitSel.length > 0 || fr.textHit || fr.urlHit
          if (isCaptcha) {
            skipCaptchaCheckOnce = true
            this.pauseRequested = true
            this.telemetry.log('friction', stepN, { level: 'block', kind: 'captcha', hit: fr.hitSel[0] || fr.url.slice(0, 60) })
            this.setState({ state: 'captcha', statusText: '检测到验证码/安全验证，已暂停等待人工处理' })
            this.tabManager.notifyCaptcha(fr.hitSel[0] || fr.url.slice(0, 60) || '页面文本特征')
            // 记录一条提示性步骤
            this.recordStep(stepN, '检测到验证码/安全验证，已自动暂停，请人工完成后点击「继续」', [
              { name: 'wait', result: '等待人工完成验证' }
            ], tab)
            continue
          }
          if (fr.warnHit) {
            // R3-D2 指数退避：warn 级信号连续出现时逐步放慢（基础 1.5s ×2^n，上限 30s）
            this.frictionWarns++
            const backoff = Math.min(1500 * Math.pow(2, Math.min(this.frictionWarns, 5)), 30000)
            this.telemetry.log('friction', stepN, { level: 'warn', kind: 'rate_limit', backoff, streak: this.frictionWarns })
            this.lastResults.push(
              `系统提示: 页面提示「操作过于频繁/稍后再试」（疑似限流）。已自动放慢节奏（退避 ${Math.round(backoff / 1000)}s），不要高频重试。`
            )
            await new Promise((r) => setTimeout(r, backoff))
            if (!(await this.checkpoint(epoch))) return
          } else if (this.frictionWarns > 0) {
            this.frictionWarns = 0
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

      // 3. 组装提示词并调用模型（问题经验库 + S5 自动经验库按当前页域名匹配注入）
      const tabsInfo = this.tabManager.infoList()
      const kbTips = matchKB(tab.url).map((e) => ({ domain: e.domain, problem: e.problem, solution: e.solution }))
      const expTips =
        settings.autoExperience !== false && !this.testCtx ? matchExperience(tab.url, task) : []
      // 快照当前排队指导（调用成功前不出队：暂停中断重跑本步时指导不丢）
      const guidanceCount = this.pendingGuidance.length
      const guidance = this.pendingGuidance.slice(0, guidanceCount)
      // S5 教训沉淀素材：记录本步注入的指导文本（其后的批全成功时写入 lesson）
      if (guidance.length) {
        this.lastGuidanceText = guidance
          .map((g) => g.text)
          .filter(Boolean)
          .join('；')
          .slice(0, 400)
      }
      if (localCooldown > 0) localCooldown--

      // 3.5 混合模式：本地快速决策直出简单步骤（严格门控 + 契约校验；失败/不确定立即回退云端）
      // —— v4.6 B1：先存最近一次 delta（重规划 prompt 的「失败现场」上下文）
      if (deltaHint) this.lastDeltaHint = deltaHint.slice(0, 600)
      // —— v4.6 B3：页面未变判定（本步指纹 vs 上一步指纹，在更新指纹链之前判定）。
      // 上一步动作全部成功且页面与上一步完全相同（wait 后/动作无效果的常态）→ 本步可省略元素列表。
      // canvas 页排除（正文变化不进 DOM，指纹假阴性）；连续省略 ≥2 强制回全量（防无列表空转）。
      let pageUnchanged = false
      if (
        settings.pageHashSkip !== false &&
        stepN > 2 &&
        !extract.canvasEditor &&
        curPageHash !== '' &&
        curPageHash === this.lastPageHash &&
        this.lastBatchActions.length > 0 &&
        !this.lastBatchActions.some((a) => !!a.error) &&
        this.pageOmitStreak < 2
      ) {
        pageUnchanged = true
        this.pageOmitStreak++
      } else {
        this.pageOmitStreak = 0
      }
      this.lastPageHash = curPageHash
      let localParsed: { thought: string; actions: AgentAction[] } | null = null
      if (
        settings.aiMode === 'hybrid' &&
        !this.testCtx && // 测试模式：脚本保真与断言要求高，一律云端决策
        !localDisabled &&
        localCooldown === 0 &&
        !visionActive && // 视觉信息本地小模型看不到
        guidance.length === 0 && // 人工指导/经验库是高优先指令，必须云端处理
        kbTips.length === 0 &&
        expTips.length === 0 &&
        stepN > 1 && // 首步由云端建立任务理解
        this.fastllm?.isReady() &&
        this.localGateOk(extract)
      ) {
        // v4.6 B2：失败冷却 10→5 步（10 步过长——本地偶发一次不可靠就长时间交云端税；
        // localRetry=false 时保持 v4.5 的 10 步）。声明在 try 外：catch 分支同样要用
        const localCd = settings.localRetry === false ? 10 : 5
        try {
          // P0-1（v4 方案 A1.1）：本地 prompt 只渲染窗口内前 N 个，校验/门控必须用同一窗口——
          // 此前按全量候选数校验，0.5B 幻觉出窗口外的编号（如 30~89）会通过并点击它没见过的元素
          const windowN = Math.min(30, settings.maxElements)
          const shot = await this.fastllm.decide(
            LOCAL_SYSTEM_PROMPT,
            buildLocalPrompt({
              task,
              extract,
              elementLines: this.executor.formatForPrompt(extract, windowN),
              memory: this.state.memory,
              lastResults: [...this.lastResults]
            })
          )
          if (shot) {
            const p = parseModelJson(shot)
            const err = validateLocalActions(p, Math.min(windowN, extract.candidates.length))
            if (p && !err) localParsed = p
            else localCooldown = localCd // 本地决策不可靠：冷却（v4.6 B2 默认 5 步）内全走云端
          } else {
            localCooldown = localCd
          }
          if (this.fastllm!.genMs > 10000) localDisabled = true // 本地推理 >10s（WASM 单线程），失去加速意义
        } catch {
          localCooldown = localCd
        }
      }

      let llmOut: {
        text: string
        usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
        structured?: string
      }
      const tLlm0 = Date.now()
      // v4.6 C6：本步决策调用的输出预算/模型（本地直出步为 0；云端步在 else 分支赋值）
      let stepBudget = 0
      let stepModel = settings.model
      let visionRetryUsed = false // 带图调用失败后改用纯文本重试（模型实际没看到截图）
      let localUsed = false
      let useVision = false
      let usedPlanner = false // T10 token 分列（主/planner）

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
        // 视觉截图已在元素提取时并行取得；截失败则本步静默走纯文本
        useVision = (visionActive || visionForced) && !!visionShot
        // v4.6 B3 落地：页面与上一步完全相同（且上一步全成功、非视觉步）→ 元素列表替换为一行说明。
        // 观测信息仍在（模型有历史/上一步结果/记忆可判断），单步省 ~2k token 的重复元素块
        const omitElementList = pageUnchanged && !useVision
        // v4.6 C4/C3：网格坐标粒度（文本模式 edges=首尾各 8 行）与行格式分档
        //（full 触发条件：早期步/上一步有错/视觉/兜底/canvas/密集页/开关关闭——保守侧宁可全量）
        const gridMode: 'edges' | 'all' | 'off' =
          settings.textGridCoords === 'all' ? 'all' : settings.textGridCoords === 'off' ? 'off' : 'edges'
        const dupTextGroups = (() => {
          const m = new Map<string, number>()
          for (const c of extract.candidates) {
            const k = (c.text || '').replace(/\s+/g, ' ').trim()
            if (k) m.set(k, (m.get(k) || 0) + 1)
          }
          let n = 0
          for (const v of m.values()) if (v >= 2) n++
          return n
        })()
        const obsDetail: 'full' | 'summary' =
          settings.obsDetail === false ||
          stepN <= 2 ||
          this.lastBatchActions.some((a) => !!a.error) ||
          useVision ||
          !!extract.canvasEditor ||
          dupTextGroups >= 5
            ? 'full'
            : 'summary'
        // S6 本地语义初筛：候选过多时让本地小模型挑 Top-K（语义分 Top-3 强制保留防筛掉目标；
        // 编号保持原始编号——快照解析不受影响；初筛失败自动全量，绝不丢元素）。
        // P0-4（v4 方案 S1）：预算 1.2s 到点放弃 + 连续 2 次超时本任务熔断（对齐 settle 熔断思路）；
        // 保留数 12→20 + 视口内前 8 个强制保留（云端至少看得到当前屏主要控件，防误筛）
        let keepIdx: number[] | undefined
        if (!omitElementList && settings.prescreen !== false && !prescreenDisabled && extract.candidates.length > 20) {
          try {
            const tPre0 = Date.now()
            const picked = await this.fastllm?.prescreen(
              extract.candidates.map((c) => `${c.role} ${c.text} ${c.extra}`),
              task,
              20,
              1200
            )
            const spentMs = Date.now() - tPre0
            if ((this.fastllm?.genMs || 0) > 8000) {
              prescreenDisabled = true
              this.telemetry.log('extract', stepN, { prescreenOff: true, genMs: this.fastllm?.genMs })
            } else if (spentMs > 1200 || !picked) {
              // 软预算超时/无结果：计数熔断（连续 2 次 → 本任务后续步全量列表，不再交预筛税）
              prescreenTimeouts++
              if (prescreenTimeouts >= 2) {
                prescreenDisabled = true
                this.telemetry.log('extract', stepN, { prescreenOff: true, reason: 'budget_timeout', spentMs })
              }
            } else {
              prescreenTimeouts = 0
            }
            if (picked?.length) {
              const top3: number[] = []
              for (let i = 0; i < extract.candidates.length && top3.length < 3; i++) {
                const s = scoreCandidate(
                  {
                    text: extract.candidates[i].text,
                    extra: extract.candidates[i].extra,
                    role: extract.candidates[i].role,
                    tag: extract.candidates[i].tag,
                    anchor: extract.candidates[i].anchor
                  },
                  task
                ).score
                if (s >= 0.5) top3.push(i)
              }
              // 视口内前 8 个强制保留（P0-4/A1.2）：预筛只应「补充语义」，不应让当前屏主要控件消失
              const vpTop: number[] = []
              for (let i = 0; i < extract.candidates.length && vpTop.length < 8; i++) {
                if (extract.candidates[i].inViewport) vpTop.push(i)
              }
              keepIdx = [...new Set([...picked.filter((i) => i < extract.candidates.length), ...top3, ...vpTop])]
            }
          } catch {}
        }
        // v4.6 B3：页面未变时省略元素列表；C4/C3：网格粒度与行格式分档透传
        const elementLines = omitElementList
          ? '（页面与上一步完全相同，元素列表省略。页面没变通常意味着上一步动作未生效：可换一种方式（换目标/expect_text/坐标），或先 scroll 再判断；确需完整列表时输出 {"name":"wait","seconds":1} 后说明）'
          : this.executor.formatForPrompt(extract, settings.maxElements, useVision, keepIdx, gridMode, obsDetail)
        this.telemetry.log('extract', stepN, {
          prescreened: keepIdx?.length || extract.candidates.length,
          omitted: omitElementList || undefined,
          detail: obsDetail === 'summary' ? 'summary' : undefined
        })
        // P1-1（v4 方案 A3，v4.4 密集页修订）SoM 标注：标注集=提示词最终列出的候选（初筛后），
        // 图上编号与列表编号严格一致（图/表不一致是密集页错位主因之一）；矩形边框高亮+角标
        // 不遮控件本体（旧圆标会盖住小按钮图标）。标注只发给模型，时间线/存档用原图；
        // 失败静默降级原图。
        let visionMarked: string | null = null
        if (useVision && visionShot) {
          try {
            const listed = (keepIdx ? keepIdx.slice() : extract.candidates.map((_, i) => i)).filter(
              (i) => i < extract.candidates.length && i < settings.maxElements
            )
            const marks = listed
              .map((n) => ({ c: extract.candidates[n], n }))
              .filter(({ c }) => c.inViewport)
              .map(({ c, n }) => ({
                x: Math.round(c.rect.x),
                y: Math.round(c.rect.y),
                w: Math.round(c.rect.w),
                h: Math.round(c.rect.h),
                n
              }))
              .filter((m) => m.x + m.w > 0 && m.y + m.h > 0 && m.x < extract.viewportW && m.y < extract.viewportH)
            if (marks.length) {
              visionMarked = await tab.cdp.screenshotWithMarks(70, marks, extract.viewportW, extract.viewportH)
            }
          } catch {}
        }
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
          expTips: expTips.length ? expTips : undefined,
          plan: !this.testCtx && this.plan.length ? { nodes: this.plan, current: this.planIdx + 1 } : undefined,
          test: this.testCtx ? this.buildTestScriptContext() : undefined,
          // v3 动态后缀区注入（横切约束 1：只进缓存断点之后；本地链路/测试模式的反思由门控排除）
          tried: settings.reflection !== false && !this.testCtx && this.triedList.length ? this.triedPromptLines() : undefined,
          deltaHint,
          // v4.6 C1：vision/canvas/test 附加段迁到 user 消息尾区（system 恒定，缓存断点不被击穿）；
          // stableSystemPrompt=false 时走旧的 system 拼接（附加段不入 user 消息）
          modeSuffix:
            settings.stableSystemPrompt === false
              ? undefined
              : buildModeSuffix({
                  vision: useVision ? (visionActive ? 'on' : 'fallback') : undefined,
                  canvas: !!extract.canvasEditor,
                  test: !!this.testCtx
                }),
          // v4.6 C2a：超长任务历史折叠（>12 步折叠早期步骤；开关关闭则恒全量）
          historyFold: settings.historyFold !== false
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
                ...(useVision ? [{ type: 'image' as const, dataUrl: visionMarked || visionShot! }] : []),
                ...guidanceImages
              ]
            : userMsg
        // 测试模式追加测试规则段（普通任务追加空串，提示词逐字节不变）
        // 视觉兜底步用 FALLBACK 段：额外放行「按截图坐标点击」，解决元素列表里根本没有目标的情况
        // canvas 编辑器（WPS 等）：豁免视觉模式「禁止坐标点击」禁令——正文不在元素列表，坐标是唯一通道
        // v4.6 C1：附加段默认迁到 user 消息尾区（buildModeSuffix），system 恒等于 SYSTEM_PROMPT——
        // 任一开关变化不再击穿 Anthropic cache_control 断点与 OpenAI 自动前缀缓存。
        // stableSystemPrompt=false 时保持 v4.5 行为（拼进 system）作回滚通道。
        const legacySystem = settings.stableSystemPrompt === false
        const systemPrompt = legacySystem
          ? (useVision ? SYSTEM_PROMPT + (visionActive ? VISION_ADDON : VISION_FALLBACK_ADDON) : SYSTEM_PROMPT) +
            (extract.canvasEditor ? CANVAS_EDITOR_ADDON : '') +
            (this.testCtx ? TEST_MODE_ADDON : '')
          : SYSTEM_PROMPT

        // T10 专家重试（W9）：卡住节点的单次 planner 调用——仅本次调用走 planner，成功立即回落主模型
        const usePlanner = this.expertArmed && !!plannerProvider
        const callProvider = usePlanner ? plannerProvider! : provider
        usedPlanner = usePlanner
        // v4.6 C6：决策步输出预算按调用模型档位分档（实测均值 119 token vs 旧固定 2048；
        // 推理模型留 2048 思考余量；截断自愈触发后回退旧值）
        // v4.6 C6：决策步输出预算按调用模型档位分档（实测均值 119 token vs 旧固定 2048；
        // 推理模型留 2048 思考余量；截断自愈触发后回退旧值）
        stepModel = (usePlanner ? settings.planner?.model : undefined) || settings.model
        stepBudget = this.budgetFor('step', stepModel, settings)
        if (usePlanner) {
          this.expertArmed = false
          this.telemetry.log('expert_retry', stepN, { used: this.expertRetriesUsed })
          this.setState({ statusText: `第 ${stepN} 步：卡住节点，专家重试（planner）…` })
        }
        try {
          llmOut = await callProvider.chat(systemPrompt, [{ role: 'user', content }], this.abortCtrl!.signal, {
            maxTokens: stepBudget
          })
        } catch (e: any) {
          const hasImage = Array.isArray(content)
          // 视觉模式下模型拒图（纯文本模型遇到 image 块）：降级并重跑本步（会话内记住，后续任务不再发图）
          if (hasImage && useVision && !this.abortCtrl!.signal.aborted && isVisionUnsupportedError(e)) {
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
          if (hasImage && !this.abortCtrl!.signal.aborted) {
            try {
              visionRetryUsed = true
              llmOut = await callProvider.chat(systemPrompt, [{ role: 'user', content: userMsg }], this.abortCtrl!.signal, {
                maxTokens: stepBudget
              })
              if (useVision) visionDegraded = true // 保险：未命中启发式的拒图也按降级处理
              this.lastResults.push('系统提示: 当前模型不支持图片输入，截图已被忽略，请仅依据文字与元素列表执行。')
            } catch (e2: any) {
              if (this.abortCtrl!.signal.aborted) {
                if (!(await this.checkpoint())) return
                continue
              }
              throw new Error(`模型调用失败: ${e2?.message || e2}`)
            }
          } else if (this.abortCtrl!.signal.aborted) {
            // 暂停中断：等待恢复后重跑本步；停止则结束
            if (!(await this.checkpoint())) return
            continue
          } else {
            throw new Error(`模型调用失败: ${e?.message || e}`)
          }
        }
        if (this.abortCtrl!.signal.aborted) {
          if (!(await this.checkpoint())) return
          continue
        }
      }
      // 调用成功：已注入的指导正式出队（本地路径 guidance 恒为空，不会到这里带指导）
      timings.llmMs = Date.now() - tLlm0
      if (guidanceCount > 0 && !localUsed) {
        this.pendingGuidance.splice(0, guidanceCount)
        this.setState({ statusText: `第 ${stepN} 步：模型思考中…` })
      }
      // T10 token 分列：专家重试那一步的用量归入 planner（llm_call 埋点已带 planner 标志）
      if (usedPlanner) {
        this.plannerUsage.inputTokens += llmOut.usage.inputTokens
        this.plannerUsage.outputTokens += llmOut.usage.outputTokens
      }
      this.telemetry.log('llm_call', stepN, {
        site: 'step',
        local: localUsed,
        vision: useVision,
        planner: usedPlanner,
        // T4 结构化档位（W3 度量）：本次调用实际生效的 response_format 档——
        // 与上一次不同的低档位即代表运行时降级发生（json_schema→json_object→none）
        structured: llmOut.structured || 'none',
        input: llmOut.usage.inputTokens,
        output: llmOut.usage.outputTokens,
        // v4.6 A1：缓存命中量与截断标记（C6 预算收紧的回归监控数据源）
        cachedIn: localUsed ? undefined : llmOut.usage.cachedInputTokens,
        truncated: !localUsed && llmOut.usage.outputTokens >= stepBudget ? true : undefined
      })

      const usage = {
        inputTokens: this.state.usage.inputTokens + llmOut.usage.inputTokens,
        outputTokens: this.state.usage.outputTokens + llmOut.usage.outputTokens,
        steps: stepN,
        // v4.6 A1：缓存命中累计（端点未上报时为 0——报表按「未上报」口径显示）
        cachedInputTokens: (this.state.usage.cachedInputTokens || 0) + (localUsed ? 0 : llmOut.usage.cachedInputTokens || 0),
        // T10 分列：planner 累计用量（>0 时 UI usage-bar 分列显示；未配置 planner 恒 0）
        plannerInputTokens: this.plannerUsage.inputTokens,
        plannerOutputTokens: this.plannerUsage.outputTokens
      }

      // 4. 解析模型输出
      const parsed = parseModelJson(llmOut.text)
      if (!parsed) {
        consecutiveParseFail++
        // v4.6 C6 截断自愈：输出吃满预算且解析失败 → 判定「预算过小截断思考」。
        // 首个实锤即会话级升级该模型预算（后续任务不再踩）；本任务连续 2 次再回退全部预算（双保险）
        if (!localUsed && llmOut.usage.outputTokens >= stepBudget) {
          escalateBudget(stepModel)
          this.truncFailStreak++
          if (this.truncFailStreak >= 2 && settings.outputBudget !== false && !this.legacyBudget) {
            this.legacyBudget = true
            this.telemetry.log('failure', stepN, {
              kind: 'budget_fallback',
              model: stepModel,
              budget: stepBudget,
              out: llmOut.usage.outputTokens
            })
          }
        }
        // T4 度量（W3）：解析失败进 telemetry——「解析失败步占比 <0.5%」验收的数据源
        this.telemetry.log('parse_fail', stepN, {
          attempt: consecutiveParseFail,
          structured: llmOut.structured || 'none',
          raw: llmOut.text.slice(0, 120)
        })
        this.recordStep(
          stepN,
          '（模型输出解析失败）',
          [{ name: 'wait', result: '模型输出不是合法 JSON' }],
          tab,
          { input: llmOut.usage.inputTokens, output: llmOut.usage.outputTokens }
        )
        this.setState({ usage })
        // T4：解析失败阈值 3→2 + few-shot 示例注入（动态后缀区，引导规范输出）
        this.lastResults.push(
          `系统提示: 你上一步的输出不是合法 JSON（原始输出前500字: ${llmOut.text.slice(0, 500)}）。请严格按格式输出，参考示例：\n{"thought":"点击登录按钮","actions":[{"name":"click","index":3}]}\n只输出这一个 JSON 对象，不要 markdown 代码块、不要前后缀文字。常见错误：JSON 字符串内部出现未转义的英文双引号会直接导致解析失败——引用页面文字时请用中文引号「」代替英文引号。`
        )
        if (consecutiveParseFail >= 2) {
          throw new Error('模型连续 2 次输出无法解析，请检查模型是否支持 JSON 输出或更换模型')
        }
        continue
      }
      consecutiveParseFail = 0
      this.truncFailStreak = 0 // v4.6 C6：解析成功 → 截断自愈计数归零

      if (!parsed.actions.length) {
        this.recordStep(stepN, parsed.thought || '（无动作）', [{ name: 'wait', result: '模型未输出动作' }], tab, {
          input: llmOut.usage.inputTokens,
          output: llmOut.usage.outputTokens
        })
        this.setState({ usage })
        this.lastResults.push('系统提示: actions 为空。你必须至少输出一个动作（或 done）。')
        continue
      }

      // 4.5 S4 clarify：模型不确定、向人工提问 → 暂停等人工（每任务上限 3 次，超出转提示自行判断）
      const clarifyAction = parsed.actions.find((a) => a.name === 'clarify')
      if (clarifyAction) {
        const q = (clarifyAction.query || clarifyAction.text || '').slice(0, 300) || '模型不确定目标，请指路'
        parsed.actions = parsed.actions.filter((a) => a.name !== 'clarify')
        this.clarifyCount++
        if (!this.testCtx && this.clarifyCount <= 3) {
          this.telemetry.log('human', stepN, { kind: 'clarify', query: q.slice(0, 100) })
          this.recordStep(stepN, `不确定，向人工提问：${q}`, [{ name: 'clarify', result: '已暂停等待人工回复' }], tab, {
            input: llmOut.usage.inputTokens,
            output: llmOut.usage.outputTokens
          })
          this.lastResults.push(
            `系统提示: 已把你的问题转给人工：${q}。人工回复（人工指导）后点「继续」，或直接批准节点；回复内容会在下一步注入。`
          )
          this.setState({ state: 'paused', statusText: `AI 提问等待人工：${q.slice(0, 40)}` })
          this.broadcast({ channel: 'toast', message: `AI 需要确认：${q.slice(0, 80)}`, kind: 'captcha' })
          try {
            this.tabManager.notifyHuman('AI 请求确认', q)
          } catch {}
          this.pauseRequested = true
          continue
        }
        this.lastResults.push('系统提示: clarify 次数已达上限（或测试模式不允许），请基于元素列表与语义匹配提示自行选择最可能的选项继续。')
        if (!parsed.actions.length) parsed.actions.push({ name: 'wait', seconds: 2 })
      }

      // 4.6 S4 多候选裁决：模型给出 candidates 数组时按语义分自动定夺（比模型硬选更准）
      if (settings.multiCandidate !== false) {
        for (const a of parsed.actions) {
          if (!Array.isArray(a.candidates) || !a.candidates.length || a.index != null) continue
          const scored = a.candidates
            .filter((i) => Number.isInteger(i) && i >= 0 && i < extract.candidates.length)
            .map((i) => ({
              i,
              s: scoreCandidate(
                {
                  text: extract.candidates[i].text,
                  extra: extract.candidates[i].extra,
                  role: extract.candidates[i].role,
                  tag: extract.candidates[i].tag
                },
                task
              ).score
            }))
            .sort((x, y) => y.s - x.s)
          if (scored.length && scored[0].s >= 0.6) {
            const from = a.candidates!.length
            a.index = scored[0].i
            a.candidates = undefined
            this.lastResults.push(
              `系统裁决: 从 ${from} 个候选中为 ${a.name} 选定 [${scored[0].i}]（相似度 ${Math.round(scored[0].s * 100)}%）`
            )
          } else {
            a.candidates = undefined
            a.error = '多候选均不匹配（语义相似度不足），请重新观察页面元素列表'
          }
        }
      }

      // 5. 执行动作批（测试模式：test_step_done 是控制信号，进执行器前剥离；protectedSubmit 透传生产保护）
      this.setState({ statusText: `第 ${stepN} 步：执行 ${parsed.actions.length} 个动作…`, usage })
      const stepDoneSignal = !!this.testCtx && parsed.actions.some((x) => x.name === 'test_step_done')
      let toRun = this.testCtx ? parsed.actions.filter((x) => x.name !== 'test_step_done') : parsed.actions
      const blocked: AgentAction[] = []
      // 参数契约前置拦截（WPS 任务根因 4）：缺必填参数的动作不进执行批，直接标错误反馈模型——
      // 省一次「执行器报错→下一步」的模型往返；错误文案指明补参方式
      toRun = toRun.filter((act) => {
        const miss = missingActionParam(act)
        if (miss) {
          act.error = `动作 ${act.name} 缺少必需参数 ${miss}，已拦截未执行：元素类动作必须带 index（元素列表编号）；canvas 文档编辑器写正文用 paste_rich（无需 index）`
          act.result = '已拦截（参数缺失）'
          blocked.push(act)
          return false
        }
        return true
      })
      // T8 执行前拦截（P1-10 第 4 条）：同一目标同一方式已失败 ≥2 次 → 拦下第 3 次重复，
      // 注入「换一种没试过的方式」提示（方式失败进清单；业务失败不拦，可修正后重试）
      // v4.5 P2-4：签名改为「目标指纹 × 定位策略」。此前签名是 name|text|anchor，
      // 模型的「换一种方式」常常只是换个 index/换句措辞——本质还是同一种方式，拦不住；
      // 现在同一种定位策略在同一个目标上只给 1 次预算，用尽即判定该目标当前不可达。
      if (settings.reflection !== false && !this.testCtx) {
        toRun = toRun.filter((act) => {
          const cand = act.fp
            ? extract.candidates.find((c) => c.fp === act.fp)
            : act.index != null
              ? extract.candidates[act.index]
              : undefined
          // 目标身份用 fp（跨步稳定、含行锚 → 同名元素天然区分）；无 fp 时退回旧签名
          const targetFp = cand?.fp || (cand ? `${(cand.text || cand.extra || '').slice(0, 24)}|${(cand.anchor || '').slice(0, 24)}` : '')
          const strategy = act.fp ? 'fp' : act.index != null ? 'index' : 'none'
          const sig = targetFp ? `${targetFp}` : ''
          if (sig && this.triedCount(sig, `${act.name}@${strategy}`) >= 2) {
            act.failSig = sig
            act.error =
              `目标「${(cand?.text || '').slice(0, 20)}」用${strategy === 'fp' ? '指纹' : '编号'}定位已失败 2 次，禁止第 3 次重复：` +
              `请换一种没试过的方式——换目标元素、改用 expect_text 锁定文案、或改用坐标点击（click_xy）`
            act.result = '已拦截（反思清单）'
            blocked.push(act)
            return false
          }
          return true
        })
      }
      const tAct0 = Date.now()
      const stepHits: Array<{ x: number; y: number; w: number; h: number; label?: string }> = []
      const batchOut = await this.executor.executeBatch(toRun, {
        memory: this.state.memory,
        signal: this.abortCtrl!.signal,
        settings: getSettings(),
        task: this.testCtx ? undefined : task,
        url: tab.url,
        prevActions: this.lastExecutedActions,
        protectedSubmit: this.testCtx?.protectedSubmit,
        // 测试模式专属执行开关（普通任务恒缺省，executor 分支不进入）
        softAssert: this.testCtx ? true : undefined,
        fillPreview: this.testCtx?.fillPreview,
        softErrors: this.testCtx ? this.testSoftErrors : undefined,
        timings,
        hits: stepHits
      })
      timings.actMs = Math.max(0, Date.now() - tAct0 - (timings.settleMs || 0))
      const executed = [...blocked, ...batchOut]
      // 只认实际执行成功的 done（暂停/出错打断批次时不应误判完成）
      const doneAction = executed.find((a) => a.name === 'done' && !a.error)
      // T8 失败尝试记账：方式失败进「禁止重复」清单（每目标最近 3 条、全局 20 条）
      // v4.6 B1：同一失败签名在当前节点内第 2 次出现 → 立即置 replanPending（不等 2 步无推进）；
      // 第 3 次 → 注入 clarify 建议（消耗既有 ≤3 次 clarify 预算），不再让模型用同方式硬试
      if (settings.reflection !== false && !this.testCtx) {
        for (const a of executed) {
          if (a.error && a.failSig && this.isMethodFailure(a.error)) {
            this.addTried(a.failSig, a.name, a.error)
            if (settings.replanTune !== false && this.plan.length) {
              if (this.fsigNode !== this.planIdx || this.fsigKey !== a.failSig) {
                this.fsigNode = this.planIdx
                this.fsigKey = a.failSig
                this.fsigCount = 1
              } else {
                this.fsigCount++
              }
              // 已在 replanTune 门控内（!== false），上限固定 3 次
              const replanMax = 3
              if (this.fsigCount === 2 && !this.replanPending && this.replanCount < replanMax && settings.replan !== false) {
                this.replanPending = `同一失败方式在当前节点重复出现（${a.failSig.slice(0, 40)}）`
                this.telemetry.log('replan', stepN, { trigger: this.replanPending, failSig: true })
              } else if (this.fsigCount >= 3 && this.clarifyCount < 3) {
                this.lastResults.push(
                  `系统提示: 同一目标同一方式已失败 ${this.fsigCount} 次。禁止再用同样方式重试；若换不出别的方式，请输出 {"name":"clarify","query":"…"} 向用户确认该目标的正确处理方式。`
                )
              }
            }
          }
        }
      }
      // 供 repeat 重放：剥离大文本字段，只留动作骨架（测试动作 expect/test_step_done 无重放意义，一并排除）
      this.lastExecutedActions = executed
        .filter((a) => a.name !== 'done' && a.name !== 'expect' && a.name !== 'test_step_done')
        .map(({ result: _r, error: _e, ...rest }) => rest)
      this.lastBatchActions = executed.filter((a) => a.name !== 'wait')

      // v4.6 B5 repeat 提示：连续 ≥3 步同构动作批（同名动作+同目标文案）且页面在推进 →
      // 注入一次 repeat 建议（repeat=一次决策执行多轮，0 LLM 调用）。提示只发一次/任务；
      // 走 lastResults 注入不改 SYSTEM_PROMPT（提示词逐字节零变更）。
      // 卡住时不计数（pageAdvanced=false = 页面没动，此时建议 repeat 是误导）
      if (settings.repeatNudge !== false && !this.testCtx) {
        const shapeSig = executed
          .filter(
            (x) =>
              !['wait', 'done', 'save', 'recall', 'read_content', 'extract_images', 'scroll', 'expect', 'test_step_done'].includes(
                x.name
              )
          )
          .map((x) => `${x.name}:${(x.expect_text || x.text || '').slice(0, 10)}`)
          .join('|')
        if (shapeSig) {
          if (shapeSig === this.sameShapeSig) {
            if (pageAdvanced) this.sameShapeRun++
          } else {
            this.sameShapeSig = shapeSig
            this.sameShapeRun = 1
          }
          if (this.sameShapeRun >= 3 && !this.repeatHinted) {
            this.repeatHinted = true
            this.lastResults.push(
              '系统提示: 已连续 3 步执行同构动作（翻页/批量同类操作）。若页面模式稳定，可输出 {"name":"repeat","amount":3} 一次执行多轮，省去逐步决策；中途动作出错会自动停止。'
            )
          }
        }
      }

      // v4.1 非预期跳转检测（用户提案）：同一页签内 URL 变化、且本批没有「导航意图」动作
      //（goto/back/forward/页签类/submitish）→ 大概率是误触了跳转元素。把「原 URL + 任务起始页」
      // 告知模型，由模型判断回滚（goto 返回）还是继续（打开新页面本就是本步目的）——不自动回滚，
      // 因为列表翻页/详情跳转也是普通 click 触发的合法 URL 变化。同一跳转只提醒一次
      try {
        const nowTab = this.tabManager.active()
        const nowUrl = nowTab?.url || ''
        const navIntent = executed.some(
          (a) =>
            ['goto', 'back', 'forward', 'new_tab', 'close_tab', 'switch_tab'].includes(a.name) || a.submitish === true
        )
        if (
          nowTab &&
          nowTab.id === tab.id &&
          stepStartUrl &&
          nowUrl &&
          !navIntent &&
          nowUrl.split('#')[0] !== stepStartUrl.split('#')[0] &&
          this.lastJumpNotified !== nowUrl
        ) {
          this.lastJumpNotified = nowUrl
          this.telemetry.log('friction', stepN, {
            kind: 'url_jump',
            from: stepStartUrl.slice(0, 150),
            to: nowUrl.slice(0, 150)
          })
          this.lastResults.push(
            `系统提示: 页面发生了跳转：${stepStartUrl.slice(0, 120)} → ${nowUrl.slice(0, 120)}。` +
              `若这不是任务预期（可能误触了跳转元素/广告位），请用 {"name":"goto","url":"${stepStartUrl.slice(0, 300)}"} 返回原页面后继续任务` +
              `${this.taskOriginUrl && this.taskOriginUrl !== stepStartUrl ? `（任务起始页：${this.taskOriginUrl.slice(0, 120)}）` : ''}；` +
              `若打开新页面正是本步骤的目的，请忽略本提示继续。`
          )
        }
      } catch {}

      // S2 失败分类学：先维护「同一动作连续失败」计数（loop 判定），再七类归因→分类自愈
      const failNames = executed.filter((a) => a.error).map((a) => a.name)
      if (failNames.length) {
        this.lastFailureKind = 'action_error'
        if (failNames[0] === this.failStreakName) this.failStreakCount++
        else {
          this.failStreakName = failNames[0]
          this.failStreakCount = 1
        }
      } else {
        this.failStreakName = ''
        this.failStreakCount = 0
      }
      if (settings.diagnose !== false && executed.some((a) => a.error)) {
        const d = diagnose({
          actions: executed,
          extract,
          prevExtract: this.prevExtract || undefined,
          sameActionStreak: this.failStreakCount,
          stepNo: stepN,
          maxSteps
        })
        if (d) {
          this.lastFailureKind = d.kind
          this.telemetry.log('failure', stepN, {
            kind: d.kind,
            strategy: d.strategy,
            action: failNames[0],
            error: executed.find((a) => a.error)?.error?.slice(0, 80)
          })
          await this.applyDiagnosis(d, executed, extract, task, stepN, fallbackAllowed)
        }
      } else {
        // 诊断关闭：保留原有的定位失败→视觉兜底联动
        const locateFail = executed.some(
          (a) => !!a.error && /已失效|不可见|找不到|无法定位|没有可点击|超出范围/.test(a.error)
        )
        if (locateFail) this.locateFailStreak++
        else if (executed.some((a) => !a.error)) this.locateFailStreak = 0
        if (this.locateFailStreak >= 2 && fallbackAllowed && this.visionFallbackLeft === 0) {
          this.visionFallbackLeft = 3
          this.locateFailStreak = 0
        }
      }

      // v4.5 P2-3：定位类失败 → 先做一次状态复位（关残留弹窗/回滚滚动/清 file input），
      // 再让模型重试。在坏状态上叠加重试必然失败；复位成本约 200ms，成功率提升远高于此。
      if (!this.testCtx && this.recoverCooldown <= 0) {
        const needsRecover = executed.some((a) => !!a.error && /已失效|不可见|找不到|无法定位|被其他元素遮挡|已拒绝点击/.test(a.error))
        if (needsRecover) {
          const note = await this.recoverPage(task)
          this.recoverCooldown = 1 // 每 2 步最多复位一次，避免连续弹窗下反复触发
          if (note) this.lastResults.push(`系统提示: ${note}`)
        }
      } else if (this.recoverCooldown > 0) {
        this.recoverCooldown--
      }

      // 收集动作结果供下一步（read_content / extract_images 等大文本）+ S0 动作埋点
      for (const a of executed) {
        this.telemetry.log('action', stepN, { name: a.name, ok: !a.error, error: a.error?.slice(0, 80) })
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

      // S5 经验沉淀 B：上一批注入过人工指导、且本批全部成功 → 人工的纠正是宝贵教训
      if (
        settings.autoExperience !== false &&
        !this.testCtx &&
        this.lastGuidanceText &&
        executed.length &&
        !executed.some((a) => a.error)
      ) {
        try {
          let host = ''
          try {
            host = new URL(tab.url).host
          } catch {}
          upsertExperience({
            domain: host,
            kind: 'lesson',
            key: this.lastFailureKind || '人工纠正',
            value: `用户指导（${this.lastFailureKind || '纠正'}后成功）: ${this.lastGuidanceText.slice(0, 200)}`
          })
        } catch {}
        this.lastGuidanceText = ''
      } else if (!executed.some((a) => a.error)) {
        this.lastGuidanceText = ''
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

      // 6. 记录步骤（W2 截图分级：常规步缩略图/出错步与完成步高清；视觉模式标记模型确实收到了截图）
      const shotMode = getSettings().timelineShot ?? 'smart'
      const isKeyStep = executed.some((a) => a.error) || !!doneAction
      const tShot0 = Date.now()
      let screenshot: string | null = null
      if (shotMode !== 'off') {
        if (shotMode === 'all' || isKeyStep) {
          screenshot = await tab.cdp.screenshotJpeg(70) // 高清：出错步/完成步（诊断与报告用）
        } else if (visionShot) {
          // W2/P1-11：视觉模式步复用步首已拍的高清截图，不再重拍（省一次 CDP 截图往返）
          screenshot = visionShot
        } else {
          screenshot = await tab.cdp.screenshotJpeg(42, 0.5) // 缩略图：常规步（省编码/传输/内存）
        }
      }
      timings.shotMs = (timings.shotMs || 0) + (Date.now() - tShot0)
      // T0 step 分段计时：时间线 + telemetry（报表 P50/P90 数据源）
      this.telemetry.log('step_timing', stepN, {
        extractMs: timings.extractMs,
        axMs: timings.axMs,
        llmMs: timings.llmMs,
        actMs: timings.actMs,
        settleMs: timings.settleMs,
        shotMs: timings.shotMs
      })
      const step = this.recordStep(
        stepN,
        parsed.thought,
        executed,
        tab,
        { input: llmOut.usage.inputTokens, output: llmOut.usage.outputTokens },
        screenshot || undefined,
        {
          timings,
          // 命中标记归一化 0~1（相对视口）：时间线截图随容器缩放，百分比定位随动
          hits:
            stepHits.length && extract.viewportW > 0 && extract.viewportH > 0
              ? stepHits.map((h) => ({
                  x: h.x / extract.viewportW,
                  y: h.y / extract.viewportH,
                  w: h.w / extract.viewportW,
                  h: h.h / extract.viewportH,
                  label: h.label
                }))
              : undefined
        }
      )
      if (useVision && !visionRetryUsed) step.vision = true
      if (localUsed) step.local = true
      if (this.testCtx) step.testStep = this.testCtx.stepIdx + 1
      this.broadcast({ channel: 'step', step })

      // 测试模式：断言收集 / 步骤推进 / fail-fast（返回 false 结束循环，收尾统一走 finishTest）
      if (this.testCtx && !(await this.handleTestPostBatch(executed, stepDoneSignal))) return

      // 6.5 节点链复核（普通任务）：模型声明 node_done 或输出 done 时，用节点「预期」复核本节点；
      //     未通过 → 视觉优先自愈重试（不推进、不收尾），连续失败/同错复发升级人工介入
      let nodeGateOpen = true
      if (!this.testCtx && this.plan.length && this.planIdx < this.plan.length && (parsed.nodeDone || doneAction)) {
        this.setState({ statusText: `第 ${stepN} 步：复核节点 ${this.planIdx + 1} 预期…` })
        // v4.6 C6/A2：L2 预算按模型档位分档；输出吃满预算 = 思考截断 → 会话级升级该模型预算；
        // 用量上抛进 llm_call 分账（此前这笔调用不在账里）
        const verifyModel = (plannerProvider ? settings.planner?.model : undefined) || settings.model
        const verifyBudget = this.budgetFor('verify', verifyModel, settings)
        const verdict = await verifyNode({
          node: this.plan[this.planIdx],
          cdp: tab.cdp,
          // 复核在动作执行后进行：URL/标题用页签实时值（extract 是本步开始时的旧快照）
          extract: { ...extract, url: tab.url || extract.url, title: tab.title || extract.title },
          settings,
          // T10：strict 复核 L2 走 planner（决策点升级；未配置回落主模型）
          provider: plannerProvider || provider,
          fastllm: this.fastllm,
          lastResults: this.lastResults,
          memory: this.state.memory,
          // v4.5：模型宣告 node_done 却不附证据时，本地复核的「通过」不作定论
          noEvidence: !!parsed.nodeDone && !parsed.nodeEvidence,
          maxTokens: verifyBudget,
          onUsage:
            settings.cacheAccounting === false
              ? undefined
              : (u) => {
                  if (u.outputTokens >= verifyBudget) {
                    escalateBudget(verifyModel)
                    this.telemetry.log('failure', stepN, {
                      kind: 'budget_escalate',
                      site: 'verify',
                      model: verifyModel,
                      budget: verifyBudget,
                      out: u.outputTokens
                    })
                  }
                  this.telemetry.log('llm_call', stepN, {
                    site: 'verify',
                    local: false,
                    vision: false,
                    planner: !!plannerProvider,
                    input: u.inputTokens,
                    output: u.outputTokens,
                    cachedIn: u.cachedInputTokens
                  })
                }
        })
        if (parsed.nodeEvidence) {
          this.lastResults.push(`你为本节点声明的达成证据：${parsed.nodeEvidence}`)
        }
        nodeGateOpen = this.handleNodeVerdict(verdict, stepN)
        // T10 专家重试（W9）：节点复核未通过 → 下一次调用单次走 planner（每任务 ≤3 次，成功立即回落）
        if (
          !nodeGateOpen &&
          !verdict.passed &&
          this.expertRetriesUsed < 3 &&
          plannerProvider &&
          settings.replan !== false
        ) {
          this.expertArmed = true
          this.expertRetriesUsed++
          this.lastResults.push('系统提示: 节点复核未通过，下一次决策将由专家模型（planner）单次接管重试。')
        }
      }

      // done 与节点链仲裁：声称完成但节点链未走完 → 拦下继续推进（最多拦 2 次，之后尊重模型判断收尾）
      if (doneAction && !this.testCtx && this.plan.length && (!nodeGateOpen || this.planIdx < this.plan.length)) {
        this.doneHeld++
        if (this.doneHeld <= 2) {
          const left = this.plan.length - this.planIdx
          const cur = this.plan[Math.min(this.planIdx, this.plan.length - 1)]
          this.lastResults.push(
            nodeGateOpen
              ? `系统提示: 你输出了 done，但节点链还有 ${left} 个节点未完成（当前节点${this.planIdx + 1}「${cur.intent}」预期: ${cur.expected}）。请先推进当前节点；若剩余节点确实无需执行，请在下一步说明理由后再次输出 done。`
              : `系统提示: 你输出了 done，但当前节点${this.planIdx + 1}「${cur.intent}」复核未通过（预期: ${cur.expected}）。请先把当前节点做对再收尾。`
          )
          // T9 触发条件（P0-5）：done 被拦且模型明确报告页面与预期不符
          const reported = String(doneAction.result || doneAction.value || '')
          if (/不符|不一致|不一样|错误|失败|无法/.test(reported)) {
            this.replanPending = 'done 被拦且模型报告页面与预期不符'
          }
          if (this.replanPending && this.replanCount < (settings.replanTune !== false ? 3 : 2) && settings.replan !== false) {
            await this.doReplan(task, provider, plannerProvider, extract, this.replanPending, stepN, epoch)
            if (!(await this.checkpoint(epoch))) return
          }
          continue
        }
      }

      if (doneAction) {
        // T9 硬门禁（P0-5）：重规划过的任务 done 强制云端 L2 复核——
        // 不允许本地复核放行、不允许 skip；复核不通过按重规划失败处理（升级人工）
        if (this.replanCount > 0 && !this.testCtx && this.plan.length) {
          this.setState({ statusText: `第 ${stepN} 步：重规划任务收尾，强制云端 L2 复核…` })
          const l2Model = (plannerProvider ? settings.planner?.model : undefined) || settings.model
          const l2Budget = this.budgetFor('verify', l2Model, settings)
          const finalVerdict = await verifyNode({
            node: this.plan[this.plan.length - 1],
            cdp: tab.cdp,
            extract: { ...extract, url: tab.url || extract.url, title: tab.title || extract.title },
            settings: { verifyMode: 'strict' },
            provider: plannerProvider || provider,
            fastllm: undefined,
            lastResults: this.lastResults,
            memory: this.state.memory,
            forceL2: true,
          // v4.6 C6/A2：收尾强制 L2 同样分预算 + 截断升级 + 分账
          maxTokens: l2Budget,
          onUsage:
            settings.cacheAccounting === false
              ? undefined
              : (u) => {
                  if (u.outputTokens >= l2Budget) escalateBudget(l2Model)
                  this.telemetry.log('llm_call', stepN, {
                    site: 'verify',
                    local: false,
                    vision: false,
                    planner: !!plannerProvider,
                    forceL2: true,
                    input: u.inputTokens,
                    output: u.outputTokens,
                    cachedIn: u.cachedInputTokens
                  })
                }
          })
          this.telemetry.log('verify', stepN, {
            forceL2: true,
            passed: finalVerdict.passed,
            source: finalVerdict.source
          })
          if (!finalVerdict.passed) {
            // 重规划失败处理：升级人工（不自动 skip、不强收尾）
            this.lastResults.push(
              `系统提示: 任务收尾的强制 L2 复核未通过（${finalVerdict.reason}）。重规划后的结果未达最终预期，请人工确认/修正后点「继续」。`
            )
            this.setState({ state: 'paused', statusText: `收尾 L2 复核未通过：${finalVerdict.reason}，等待人工` })
            this.broadcast({
              channel: 'toast',
              message: `重规划后收尾 L2 复核未通过：${finalVerdict.reason}`,
              kind: 'captcha'
            })
            try {
              this.tabManager.notifyHuman('收尾复核未通过', finalVerdict.reason)
            } catch {}
            this.pauseRequested = true
            continue
          }
        }
        this.telemetry.end({ state: 'success', steps: this.steps.length, tokens: this.state.usage })
        // S5 经验沉淀 C：任务成功 → 成功路径（同站点同类任务下次直接参考）+ 命中经验加分
        if (settings.autoExperience !== false && !this.testCtx) {
          try {
            let host = ''
            try {
              host = new URL(tab.url).host
            } catch {}
            if (this.plan.length) {
              upsertExperience({
                domain: host,
                kind: 'path',
                key: task.slice(0, 16),
                value: this.plan.map((n) => n.intent).join(' → ').slice(0, 300)
              })
            }
            feedbackExperience(tab.url, task, true)
          } catch {}
        }
        this.setState({
          state: 'done',
          statusText: '任务完成',
          result: doneAction.result || doneAction.value || '任务完成',
          stepCount: this.steps.length,
          totalMs: this.taskStartedAt ? Date.now() - this.taskStartedAt : undefined
        })
        // v4.3：完成 toast 带总耗时（面板 usage-bar 与日志页也有明细）
        const totalTxt = this.taskStartedAt ? `（总耗时 ${fmtTaskDur(Date.now() - this.taskStartedAt)}）` : ''
        this.broadcast({ channel: 'toast', message: `任务完成${totalTxt}：${(doneAction.result || '').slice(0, 80)}`, kind: 'success' })
        return
      }

      // T9 重规划触发（P0-5）：连续 N 步无任何节点推进 → 重排剩余节点（上限 M 次）。
      // 「无推进」按计划原文口径：只要有实际动作执行而 planIdx 未动就计数——
      // 纯原地空转（反复滚动/读页不带错误）同样是卡住信号，不应只盯显式失败。
      // v4.6 B1（replanTune）：N 3→2（一次循环已经烧掉 2 次云端调用 ≈13k token）、上限 2→3 次；
      // replanTune=false 时保持 v4.5 阈值（3 步/2 次）
      {
        const replanMax = settings.replanTune !== false ? 3 : 2
        const noProgMax = settings.replanTune !== false ? 2 : 3
        if (!this.testCtx && this.plan.length && settings.replan !== false && this.replanCount < replanMax) {
          if (this.planIdx > this.progressAnchorIdx) {
            this.progressAnchorIdx = this.planIdx
            this.noProgressSteps = 0
          } else if (executed.length > 0) {
            this.noProgressSteps++
            if (this.noProgressSteps >= noProgMax && !this.replanPending) {
              this.replanPending = `连续 ${this.noProgressSteps} 步无节点推进`
            }
          }
          if (this.replanPending) {
            await this.doReplan(task, provider, plannerProvider, extract, this.replanPending, stepN, epoch)
            if (!(await this.checkpoint(epoch))) return
          }
        }
      }
    }
  }

  private recordStep(
    n: number,
    thought: string,
    actions: AgentAction[],
    tab: { id: number; title: string; url: string },
    tokens?: { input: number; output: number },
    screenshot?: string,
    extra?: { timings?: StepTimings; hits?: StepRecord['hits'] }
  ): StepRecord {
    const step: StepRecord = {
      n,
      thought,
      actions,
      tabId: tab.id,
      tabTitle: tab.title,
      url: tab.url,
      title: '',
      nodeIdx: this.plan.length && !this.testCtx ? Math.min(this.planIdx + 1, this.plan.length) : undefined,
      tokens,
      screenshot,
      timings: extra?.timings,
      hits: extra?.hits,
      ts: Date.now()
    }
    this.steps.push(step)
    // 时间线截图内存上限：只保留最近 40 步的截图（每张 JPEG 数百 KB，长任务全量保留会拖高
    // 主进程内存）；带动作出错的步保留——测试报告的失败步骤截图靠倒查时间线取用
    const keep = 40
    const stale = this.steps.length > keep ? this.steps[this.steps.length - keep - 1] : null
    if (stale?.screenshot && !stale.actions.some((a) => a.error)) stale.screenshot = undefined
    this.setState({ stepCount: this.steps.length })
    return step
  }
}
