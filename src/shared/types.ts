// 主进程与渲染进程共享的类型契约

/** LLM 协议：OpenAI 兼容 / Anthropic 兼容 */
export type Protocol = 'openai' | 'anthropic'

/** cc-switch 导入的供应商条目 */
export interface CCSwitchProviderInfo {
  id: string
  appType: string
  name: string
  isCurrent: boolean
  protocol: Protocol
  baseURL: string
  apiKey: string
  model: string
}

export interface Settings {
  provider: Protocol
  baseURL: string
  apiKey: string
  model: string
  maxSteps: number
  maxElements: number
  /** AI 处理模式：hybrid 混合（本地快速决策模型辅助，推荐）/ cloud 纯大模型 */
  aiMode: 'hybrid' | 'cloud'
  /** 视觉模式：每步把视口截图发给模型（需模型支持图片输入，不支持时自动降级为纯元素列表） */
  vision: boolean
  /** 视觉兜底：元素列表定位不到目标时，自动截图给模型做「看图定位」（含坐标点击），不必全程开视觉模式 */
  visionFallback: boolean
  /** 测试：复用已保存的登录态（启动先探测，已登录则跳过登录步骤；失效才重登） */
  testLoginReuse: boolean
  /** 拟人化速度：normal 正常 / slow 慢速（风控敏感站点） */
  speed: 'normal' | 'slow'
  /** 支持后台/最小化运行（抑制 Chromium 后台节流；重启应用后生效，默认关=与历史行为一致） */
  bgRun?: boolean
  homepage: string
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  maxSteps: 30,
  maxElements: 80,
  aiMode: 'hybrid',
  vision: false,
  visionFallback: true,
  testLoginReuse: true,
  speed: 'normal',
  bgRun: false,
  homepage: 'https://www.baidu.com'
}

export const MAX_TABS = 5

/** 布局常量（渲染进程与主进程共同遵守，用于摆放浏览器视图；面板实际宽度以 styles.css 为准） */
export const LAYOUT = {
  TAB_BAR_H: 36,
  TOOLBAR_H: 44,
  PANEL_W: 420
}

export interface TabInfo {
  id: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 收藏的站点（收藏栏） */
export interface Bookmark {
  title: string
  url: string
  ts: number
}

/** 浏览历史条目（主进程记录并持久化） */
export interface HistoryEntry {
  url: string
  title: string
  ts: number
  /** 累计访问次数 */
  count: number
}

/** 问题经验库条目：用户积累的“某站点某问题的正确处理方式”，按域名注入 AI 提示词 */
export interface KBEntry {
  id: number
  /** 适用站点域名（如 docs.qq.com），空=全局适用 */
  domain: string
  /** 问题描述（如：找不到输入框） */
  problem: string
  /** 正确处理方式（注入给 AI 的指令） */
  solution: string
  enabled: boolean
}

export type ActionName =
  | 'click'
  | 'type'
  | 'paste_rich'
  | 'paste_image'
  | 'repeat'
  | 'scroll'
  | 'drag'
  | 'goto'
  | 'back'
  | 'forward'
  | 'wait'
  | 'read_content'
  | 'extract_images'
  | 'save'
  | 'recall'
  | 'new_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'done'
  // —— 测试模式动作（仅测试脚本使用；普通任务提示词不包含它们） ——
  | 'expect'
  | 'test_step_done'
  | 'fill_form'
  | 'upload'
  | 'hover'
  // 视觉兜底：按截图归一化坐标点击（0~1000），用于元素列表定位不到目标时
  | 'click_xy'

/** expect 断言类型 */
export type ExpectKind =
  | 'text_visible'
  | 'url_contains'
  | 'title_contains'
  | 'selector_exists'
  | 'selector_value'
  | 'selector_text'
  | 'api_status'
  | 'api_body'

export interface AgentAction {
  name: ActionName
  index?: number
  /** drag：拖动目标元素编号（把 index 元素拖到 index2 元素上） */
  index2?: number
  text?: string
  url?: string
  key?: string
  value?: string
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'
  amount?: number
  seconds?: number
  /** expect：断言类型 */
  kind?: ExpectKind
  /** expect：selector_* 类断言的 CSS 选择器 */
  selector?: string
  /** expect：api_* 类断言的 URL 片段（匹配最近一次请求） */
  urlPart?: string
  /** expect：断言取反（不包含/不存在） */
  negate?: boolean
  /** fill_form：显式字段映射（「字段描述→值」；缺省走 AI 智能填充） */
  data?: Record<string, string>
  /** fill_form：只填必填项 */
  onlyRequired?: boolean
  /** upload：本地文件绝对路径（支持 {{变量}}，测试数据表用 @路径 约定） */
  path?: string
  /** click_xy：截图上的归一化横坐标 0~1000（左上角 0，右下角 1000） */
  x?: number
  /** click_xy：截图上的归一化纵坐标 0~1000 */
  y?: number
  /** 执行结果摘要（主进程回填） */
  result?: string
  /** 执行错误（主进程回填） */
  error?: string
}

export interface StepRecord {
  n: number
  thought: string
  actions: AgentAction[]
  tabId: number
  tabTitle: string
  url: string
  title: string
  /** 视口截图 jpeg dataURL（时间线展示；视觉模式下的模型输入截图另行截取） */
  screenshot?: string
  /** 本步模型是否收到了页面截图（视觉模式） */
  vision?: boolean
  /** 本步由本地快速决策模型直出（⚡ 混合模式加速，未走云端） */
  local?: boolean
  tokens?: { input: number; output: number }
  ts: number
  /** 用户人工指导（暂停/运行中发的消息），时间线里渲染为用户气泡 */
  userGuidance?: boolean
  /** 测试模式：本模型步属于测试用例的第几步（时间线分组标记） */
  testStep?: number
}

/** 暂停/运行期间用户给 AI 的人工指导（文字 + 可选截图指路） */
export interface GuidanceMessage {
  ts: number
  text: string
  /** jpeg dataURL（用户剪贴板截图，发送给多模态模型看图指路） */
  image?: string
}

// ———————————————— 浏览器仿真测试（feature/browser-test）————————————————

/** 测试环境档案（多环境切换 + 生产保护） */
export interface TestEnv {
  name: string
  baseUrl: string
  /** 生产保护环境：提交类点击与智能填充结果需人工确认后才执行 */
  protected: boolean
}

/** 用例库条目（应用内保存的测试用例，可运行/定时回归/失败重跑） */
export interface TestCaseEntry {
  id: number
  name: string
  /** 用例 MD 原文 */
  md: string
  tags: string[]
  createdAt: number
  lastRunAt?: number
  lastVerdict?: string
}

/** 测试用例中的一条断言（由用例 MD 的「预期」行解析而来） */
export interface TestAssertion {
  /** MD 原文（报告回显） */
  raw: string
  /** ai=未标类型的自然语言预期，由模型翻译成 expect 动作 */
  kind: ExpectKind | 'ai'
  value?: string
  selector?: string
  /** api_* 类断言的 URL 片段 */
  urlPart?: string
  negate?: boolean
}

export interface TestStep {
  title: string
  /** 操作描述（自然语言，模型翻译成动作序列） */
  action: string
  /** 预期断言（可为空：纯操作步骤） */
  assertions: TestAssertion[]
  /** 该步骤遇 JS 弹窗的应答覆盖（缺省=确认） */
  dialog?: 'accept' | 'dismiss'
  /** 解析期识别为「登录类」步骤（登录态复用时可跳过其操作） */
  login?: boolean
}

/** 数据驱动：一组测试数据（### 组名 小节；缺省单组=vars） */
export interface TestGroup {
  name: string
  vars: Record<string, string>
}

/** 解析后的测试用例（parser 产物） */
export interface TestCase {
  name: string
  /** 数据表变量（注入任务记忆，{{变量}} 处替换） */
  vars: Record<string, string>
  steps: TestStep[]
  /** 多组数据驱动（数据区含 ### 组名 小节时存在；runner 逐组执行同一脚本） */
  groups?: TestGroup[]
}

export interface TestAssertionResult {
  raw: string
  kind: string
  passed: boolean
  /** 断言时页面实际值（失败时定位用） */
  actual?: string
}

export type TestStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export interface TestStepResult {
  /** 1-based 步骤序号 */
  index: number
  title: string
  status: TestStepStatus
  assertions: TestAssertionResult[]
  /** 该步骤消耗的模型步数 */
  modelSteps: number
  error?: string
  /** 步骤备注（如「已复用保存的登录态，跳过登录操作」） */
  note?: string
  /** 失败截图文件名（reports/<run>/shots/ 下） */
  shotFile?: string
}

export type TestRunState = 'running' | 'passed' | 'failed' | 'error' | 'stopped'

/** 一次测试运行的全量状态（经 test-run 事件推送到测试面板） */
export interface TestRunStatus {
  /** 运行代号（主进程每次启动递增；旧循环的收尾不得污染新运行） */
  runId?: number
  state: TestRunState
  caseName: string
  envName?: string
  /** 数据驱动多组时的当前组名 */
  groupName?: string
  totalSteps: number
  /** 当前执行到的步骤（1-based；0=未开始） */
  currentStep: number
  steps: TestStepResult[]
  passed: number
  failed: number
  reportPath?: string
  error?: string
  startedAt?: number
  endedAt?: number
  tokens: { input: number; output: number }
}

export type AgentRunState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'captcha' // 检测到验证码，人工接管中
  | 'done'
  | 'error'
  | 'stopped'

export interface AgentStatus {
  state: AgentRunState
  task: string
  stepCount: number
  statusText: string
  usage: { inputTokens: number; outputTokens: number; steps: number }
  memory: Record<string, string>
  result?: string
  /** 已排队未注入给模型的人工指导条数 */
  pendingGuidance?: number
}

/** 本地快速决策模型状态（混合模式） */
export interface FastLlmState {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  progress?: number
  detail?: string
  /** 模型已内置在安装包中（无需下载） */
  bundled?: boolean
}

/** 定时任务：到点自动把任务描述交给 AI 执行 */
export interface Schedule {
  id: number
  /** 显示名（默认取任务描述前 20 字） */
  name: string
  /** 任务描述（到点交给 AI 执行的完整指令） */
  task: string
  /** 绑定测试用例库条目：到点跑该用例（定时回归）而非自由任务 */
  testCaseId?: number
  enabled: boolean
  /** once=执行一次(at 为绝对时间戳)；daily=每天 dailyMinute(0-1439)；interval=每 intervalMin 分钟 */
  type: 'once' | 'daily' | 'interval'
  at?: number
  dailyMinute?: number
  intervalMin?: number
  createdAt: number
  lastRun?: number
  /** 下次触发时间戳（主进程计算回写） */
  nextRun: number
}

/** 渲染进程事件（经 preload 订阅） */
export type MainEvent =
  | { channel: 'tabs'; tabs: TabInfo[]; activeTabId: number }
  | { channel: 'agent-status'; status: AgentStatus }
  | { channel: 'step'; step: StepRecord }
  | { channel: 'toast'; message: string; kind: 'info' | 'success' | 'error' | 'captcha' }
  | { channel: 'ocr-status'; enabled: boolean; reason?: string }
  | { channel: 'fastllm'; status: FastLlmState }
  | { channel: 'schedules'; schedules: Schedule[] }
  /** 定时任务即将执行：secondsLeft ≤ 60 时每秒推送一次（顶部倒计时条 + 取消按钮） */
  | { channel: 'schedule-countdown'; id: number; name: string; secondsLeft: number }
  /** 测试运行状态变更（进度/步骤结果/最终报告路径） */
  | { channel: 'test-run'; run: TestRunStatus }

export interface ExtractDebugResult {
  count: number
  lines: string[]
  title: string
  url: string
}

/** window.easybow 的类型（preload 暴露） */
export interface EasybowApi {
  getSettings(): Promise<Settings>
  setSettings(s: Settings): Promise<Settings>
  testConnection(): Promise<{ ok: boolean; message: string; usage?: { inputTokens: number; outputTokens: number } }>
  // 从本机 cc-switch 读取可导入的供应商列表
  listCCSwitchProviders(): Promise<CCSwitchProviderInfo[]>
  /** 读取系统剪贴板图片（人工介入附截图用）：PNG/JPEG dataURL，无图返回 null */
  readClipboardImage(): Promise<string | null>
  // 本地快速决策模型（混合模式）
  fastllmStatus(): Promise<FastLlmState>
  /** 下载并加载本地快速决策模型（幂等），进度经 fastllm 事件推送 */
  fastllmInit(): Promise<FastLlmState>
  // 定时任务
  getSchedules(): Promise<Schedule[]>
  /** 新建或更新（带 id 为更新，无 id 为新建） */
  saveSchedule(s: Omit<Schedule, 'id' | 'createdAt' | 'nextRun' | 'lastRun'> & { id?: number }): Promise<Schedule[]>
  deleteSchedule(id: number): Promise<Schedule[]>
  /** 取消即将执行的这一次（不删除任务、不改策略） */
  cancelScheduledRun(id: number): Promise<Schedule[]>
  /** 应用版本号（关于信息用） */
  appVersion(): Promise<string>
  // 问题经验库
  getKB(): Promise<KBEntry[]>
  setKB(entries: KBEntry[]): Promise<KBEntry[]>
  // 页签
  newTab(url?: string): Promise<{ tabs: TabInfo[]; activeTabId: number }>
  closeTab(id: number): Promise<{ tabs: TabInfo[]; activeTabId: number }>
  switchTab(id: number): Promise<{ tabs: TabInfo[]; activeTabId: number }>
  navigate(url: string): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  reload(): Promise<void>
  // 浏览历史
  listHistory(query?: string): Promise<HistoryEntry[]>
  removeHistory(url: string): Promise<void>
  clearHistory(): Promise<void>
  // Agent
  startTask(task: string): Promise<void>
  pauseTask(): Promise<void>
  resumeTask(): Promise<void>
  stopTask(): Promise<void>
  /** 暂停/运行中给 AI 发人工指导（文字 + 可选截图），下一步注入模型提示词 */
  sendGuidance(text: string, imageDataUrl?: string): Promise<void>
  getAgentStatus(): Promise<AgentStatus>
  // 浏览器仿真测试
  /** 需求 MD → 测试用例 MD（prd=PRD提炼拆用例 / rough=粗步骤补全断言），一次 LLM 调用 */
  testConvert(
    reqMd: string,
    mode: 'prd' | 'rough'
  ): Promise<{ ok: boolean; md?: string; error?: string; steps?: number; assertions?: number; attempts?: number }>
  /** 校验测试用例 MD（解析给 UI 预览步骤数/断言数/变量 + 步骤节点明细，供行内编辑重渲染） */
  testParse(md: string): Promise<{
    ok: boolean
    error?: string
    name?: string
    steps?: number
    assertions?: number
    vars?: string[]
    groups?: number
    /** 步骤节点明细（1-based，与 MD 中 ### 小节一一对应） */
    stepsDetail?: Array<{
      index: number
      title: string
      action: string
      assertions: string[]
      dialog?: 'accept' | 'dismiss'
      login?: boolean
      cleanup?: boolean
    }>
  }>
  /** 行内编辑单个步骤：改标题/操作/预期（或删除、在下方插入），返回新的用例 MD */
  testEditStep(
    md: string,
    index: number,
    patch: { op: 'update'; title?: string; action?: string; assertions?: string[]; dialog?: 'accept' | 'dismiss' | '' } | { op: 'delete' } | { op: 'insert'; title?: string; action?: string; assertions?: string[] }
  ): Promise<{ ok: boolean; md?: string; error?: string }>
  /** 运行测试：解析 MD → 独立测试页签（独立登录分区）执行 → 报告 */
  testStart(
    md: string,
    opts: { envName?: string; failFast: boolean; fillPreview?: boolean; loginReuse?: boolean }
  ): Promise<void>
  /** 强制重置「卡在执行中」的测试状态（UI 看门狗/用户手动兜底） */
  testReset(): Promise<TestRunStatus | null>
  /** 停止测试（与停止任务同一管线） */
  testStop(): Promise<void>
  /** 当前/最近一次测试运行状态 */
  testRunStatus(): Promise<TestRunStatus | null>
  /** 历史报告列表 */
  testListReports(): Promise<Array<{ file: string; ts: number; verdict: string }>>
  /** 读取某次报告内容（Markdown） */
  testReadReport(file: string): Promise<string>
  /** 打开报告目录（资源管理器） */
  testOpenReports(): Promise<void>
  /** 测试环境档案 */
  getTestEnvs(): Promise<TestEnv[]>
  setTestEnvs(envs: TestEnv[]): Promise<TestEnv[]>
  /** 用例库：列表/保存（带 id 为更新）/删除/单取 */
  getTestCases(): Promise<TestCaseEntry[]>
  saveTestCase(entry: { name: string; md: string; tags?: string[]; id?: number }): Promise<TestCaseEntry[]>
  deleteTestCase(id: number): Promise<TestCaseEntry[]>
  /** 失败重跑：按步骤序号取子集，生成新的用例 MD（返回到编辑器人工确认后运行） */
  testSubcase(md: string, keepStepIdx: number[], suffix?: string): Promise<{ ok: boolean; md?: string; error?: string }>
  // 调试
  debugExtract(): Promise<ExtractDebugResult>
  // 布局：浏览器区域（窗口内容坐标，DIP）
  setBrowserRect(rect: { x: number; y: number; width: number; height: number }): void
  // 弹窗打开时隐藏浏览器视图（避免原生视图盖住弹窗），关闭时恢复
  setBrowserHidden(hidden: boolean): void
  onEvent(cb: (ev: MainEvent) => void): () => void
}
