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
  /** 拟人化速度：normal 正常 / slow 慢速（风控敏感站点） */
  speed: 'normal' | 'slow'
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
  speed: 'normal',
  homepage: 'https://www.baidu.com'
}

export const MAX_TABS = 5

/** 布局常量（渲染进程与主进程共同遵守，用于摆放浏览器视图） */
export const LAYOUT = {
  TAB_BAR_H: 36,
  TOOLBAR_H: 44,
  PANEL_W: 380
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
}

/** 暂停/运行期间用户给 AI 的人工指导（文字 + 可选截图指路） */
export interface GuidanceMessage {
  ts: number
  text: string
  /** jpeg dataURL（用户剪贴板截图，发送给多模态模型看图指路） */
  image?: string
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
}

/** 定时任务：到点自动把任务描述交给 AI 执行 */
export interface Schedule {
  id: number
  /** 显示名（默认取任务描述前 20 字） */
  name: string
  /** 任务描述（到点交给 AI 执行的完整指令） */
  task: string
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
  // 调试
  debugExtract(): Promise<ExtractDebugResult>
  // 布局：浏览器区域（窗口内容坐标，DIP）
  setBrowserRect(rect: { x: number; y: number; width: number; height: number }): void
  // 弹窗打开时隐藏浏览器视图（避免原生视图盖住弹窗），关闭时恢复
  setBrowserHidden(hidden: boolean): void
  onEvent(cb: (ev: MainEvent) => void): () => void
}
