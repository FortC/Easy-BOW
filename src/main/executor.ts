import type { TabManager, Tab } from './tabs'
import type { Overlay } from './overlay'
import { clipboard, nativeImage, ClipboardItem, dialog } from 'electron'
import type { WebContents } from 'electron'
import {
  EXTRACT_FN,
  RESOLVE_FN,
  READ_CONTENT_FN,
  EXTRACT_IMAGES_FN,
  type Candidate,
  type ExtractResult,
  formatCandidates,
  rerankByTask
} from './extractor'
import { mdToHtml, mdToPlain } from './markdown'
import { decodeImageToPng } from './imgdec'
import { EXPECT_TEXT_FN, EXPECT_SEL_FN, SOFT_ERR_FN } from './testcase/assertions'
import { FORM_FIELDS_FN, FORM_SET_FN, type FormField } from './testcase/fields'
import { scoreCandidate, verifyFieldMatch, extractKeywords } from './semantic'
import { upsertExperience } from './experience'
import { getSettings } from './settings'
import { existsSync, statSync } from 'fs'
import type { AgentAction, Settings, StepTimings } from '@shared/types'

/** T7 写操作判定（提交/保存/删除/支付/下单…）：坐标兜底禁用 + 提交后等待（P0-1 硬门禁） */
const SUBMITISH_RE = /提交|确定|保存|下单|支付|发布|删除|结算|确认|submit|save|delete|remove|pay|order|publish|confirm/i

/** 目标文案是否写操作（禁裸坐标兜底的硬门禁依据） */
export function isSubmitishLabel(label: string): boolean {
  return SUBMITISH_RE.test(label || '')
}

export interface ExecContext {
  memory: Record<string, string>
  signal: AbortSignal
  settings: Settings
  /** 任务描述（S1 填后语义校验 + 经验沉淀用；自测/单动作调用可缺省） */
  task?: string
  /** 当前页面 URL（经验沉淀按域名归档用） */
  url?: string
  /** 上一步执行成功的动作骨架（repeat 重放用；可缺省） */
  prevActions?: AgentAction[]
  /** 测试模式：生产保护环境下为 true，提交类点击前需人工确认（普通任务恒缺省） */
  protectedSubmit?: boolean
  /** 测试模式：提交类点击后自动软断言（页面校验错误提示兜底；普通任务恒缺省） */
  softAssert?: boolean
  /** 测试模式：智能填充前弹人工预览确认（普通任务恒缺省） */
  fillPreview?: boolean
  /** 测试模式跨步骤共享：软断言收集（runner 持有数组，步骤完成时统一判定） */
  softErrors?: string[]
  /** T0 step 分段计时（runner 传入，executor 回填 settleMs） */
  timings?: StepTimings
  /** T3 点击命中记录（点击坐标 + 目标 rect），runner 收进 StepRecord.hits 渲染时间线标记 */
  hits?: Array<{ x: number; y: number; w: number; h: number; label?: string }>
}

interface Resolved {
  found: boolean
  x?: number
  y?: number
  tag?: string
  editable?: boolean
  value?: string
  w?: number
  h?: number
  /** T5 state 时效：执行前实时属性（快照的 disabled/checked 是时点值，不可信） */
  disabled?: boolean
  checked?: boolean
  /** 实际解析命中的候选（重定位后与原快照序号可能不同）：
   *  路径定位/赋值回读/标签判定必须全部消费它——否则点击的是重定位元素、
   *  赋值却落在旧快照序号上，重复文案/空文本控件场景直接「填错字段」（P0-1） */
  cand?: Candidate
}

/** T5 坐标命中护栏：elementFromPoint 校验最上层元素与目标一致，不一致放弃坐标法（P0-1） */
const HIT_TEST_FN = String(function hitTest(x: number, y: number, expectTag?: string, expectText?: string) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return { ok: false, reason: '坐标处无可命中元素' }
  const tag = el.tagName
  const norm = (s: unknown): string => String(s || '').replace(/\s+/g, ' ').trim()
  const text = norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder'))
  if (expectTag && tag.toUpperCase() !== expectTag.toUpperCase()) {
    // shadow/自定义元素场景：目标在命中元素内部也算一致
    const inner = el.querySelector(expectTag)
    if (!inner) return { ok: false, tag, text: text.slice(0, 30), reason: `命中 <${tag}> 与目标 <${expectTag}> 不一致` }
  }
  if (expectText && text && !text.includes(expectText) && !expectText.includes(text)) {
    return { ok: false, tag, text: text.slice(0, 30), reason: `命中元素文本 "${text.slice(0, 20)}" 与目标 "${expectText.slice(0, 20)}" 不一致` }
  }
  return { ok: true, tag, text: text.slice(0, 30) }
})

/** 安全设置 input/textarea 的值（走原生 setter，React 受控组件可感知） */
const SET_VALUE_FN = String(function setValue(framePaths: number[][], path: number[], value: string) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // shadow 边界哨兵（与 extractor path 编码契约一致）：进入当前节点的 shadowRoot
        const sr = el && el.shadowRoot
        if (!sr) return null
        el = sr
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
  }
  let doc: Document = document
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return { ok: false }
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return { ok: false }
    }
    if (!doc) return { ok: false }
  }
  const el = walk(doc, path) as any
  if (!el) return { ok: false }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    desc?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, kind: 'input' }
  }
  if (el.isContentEditable) {
    el.focus()
    document.execCommand('selectAll')
    return { ok: true, kind: 'editable' }
  }
  return { ok: false }
})

/** 读取目标元素当前值（type 动作输入后验证用） */
const READ_VALUE_FN = String(function readValue(framePaths: number[][], path: number[]) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // shadow 边界哨兵（与 extractor path 编码契约一致）：进入当前节点的 shadowRoot
        const sr = el && el.shadowRoot
        if (!sr) return null
        el = sr
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
  }
  let doc: Document = document
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return { ok: false }
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return { ok: false }
    }
    if (!doc) return { ok: false }
  }
  const el = walk(doc, path) as any
  if (!el) return { ok: false }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return { ok: true, value: String(el.value ?? '') }
  if (el.isContentEditable) return { ok: true, value: String(el.innerText ?? '') }
  return { ok: false }
})

/**
 * S1 填后语义校验用：读目标元素的语义文案（label / placeholder / name / aria / 邻近文本）。
 * 回答「刚填的输入框到底是什么字段」——值填对了 ≠ 填对了字段。
 */
const READ_LABEL_FN = String(function readLabel(framePaths: number[][], path: number[]) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // shadow 边界哨兵（与 extractor path 编码契约一致）：进入当前节点的 shadowRoot
        const sr = el && el.shadowRoot
        if (!sr) return null
        el = sr
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
  }
  let doc: Document = document
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return { found: false }
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return { found: false }
    }
    if (!doc) return { found: false }
  }
  const el = walk(doc, path)
  if (!el) return { found: false }
  const norm = function (s: any): string {
    return String(s || '').replace(/\s+/g, ' ').trim()
  }
  let label = ''
  const id = el.getAttribute('id')
  if (id) {
    let l: Element | null = null
    try {
      l = doc.querySelector(`label[for="${CSS.escape(id)}"]`)
    } catch {
      try {
        l = doc.querySelector(`label[for="${id}"]`)
      } catch {
        l = null
      }
    }
    if (l) label = norm((l as HTMLElement).innerText)
  }
  if (!label) {
    const p = el.closest('label')
    if (p) label = norm((p as HTMLElement).innerText)
  }
  let adjacent = ''
  try {
    const cell = el.closest('td,th')
    if (cell) {
      // 优先左侧单元格（label 通常在输入框左边，同行多字段时行文本会混淆语义）
      const prevCell = cell.previousElementSibling
      if (prevCell && !prevCell.querySelector('input,select,textarea')) {
        const t = norm(prevCell.textContent)
        if (t && t.length <= 12) adjacent = t.slice(0, 24)
      }
      if (!adjacent && cell.parentElement) adjacent = norm((cell.parentElement as HTMLElement).innerText).slice(0, 40)
    }
    if (!adjacent) {
      const wrap = el.closest('.form-item,.form-group,.field,.ant-form-item,.el-form-item')
      if (wrap) adjacent = norm((wrap as HTMLElement).innerText).slice(0, 40)
    }
  } catch {}
  return {
    found: true,
    label: label.slice(0, 30),
    placeholder: norm(el.getAttribute('placeholder')).slice(0, 30),
    name: norm(el.getAttribute('name')).slice(0, 30),
    aria: norm(el.getAttribute('aria-label')).slice(0, 30),
    adjacent
  }
})

const SCROLL_FN = String(function scrollTo(where: string) {
  if (where === 'top') window.scrollTo({ top: 0 })
  else if (where === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight })
})

/** upload 动作用：按 framePaths+path 找到元素并返回引用（配合 evaluateRef → DOM.setFileInputFiles） */
const UPLOAD_FIND_FN = String(function findEl(framePaths: number[][], path: number[]) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // shadow 边界哨兵（与 extractor path 编码契约一致）：进入当前节点的 shadowRoot
        const sr = el && el.shadowRoot
        if (!sr) return null
        el = sr
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
  }
  let doc: Document = document
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return null
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return null
    }
    if (!doc) return null
  }
  return walk(doc, path)
})

/** upload 动作用：回读文件框已选文件数（-1=元素不是 input[type=file]） */
const UPLOAD_COUNT_FN = String(function countFiles(framePaths: number[][], path: number[]) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // shadow 边界哨兵（与 extractor path 编码契约一致）：进入当前节点的 shadowRoot
        const sr = el && el.shadowRoot
        if (!sr) return null
        el = sr
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
  }
  let doc: Document = document
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return null
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return null
    }
    if (!doc) return null
  }
  const el = walk(doc, path) as HTMLInputElement | null
  if (!el || el.tagName !== 'INPUT') return -1
  return el.files ? el.files.length : 0
})

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** URL → 域名（经验沉淀按站点归档；解析失败返回空串=全局） */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 视口尺寸（CSS 像素）：截图归一化坐标 → 实际点击坐标换算用 */
const VIEWPORT_FN = String(function viewportSize() {
  return { w: window.innerWidth || 0, h: window.innerHeight || 0 }
})

/** 剪贴板写入带超时保护：个别环境下异步写可能不返回，挂死会卡住整个 Agent 循环 */
function clipboardWriteTimeout(ms = 8000): Promise<never> {
  return new Promise((_r, rej) => setTimeout(() => rej(new Error(`剪贴板写入超时(${ms}ms)`)), ms))
}

export class Executor {
  private tabManager: TabManager
  /** 每个页签最近一次提取快照（index → candidate 映射依据） */
  private snapshots = new Map<number, ExtractResult>()
  /** 可选：鼠标轨迹可视化覆盖层 */
  overlay: Overlay | null = null
  /** 可选：read_content 文本过少时的整页 OCR 兜底 */
  ocrPageFallback?: () => Promise<string | null>
  /** T2 熔断触发回调（runner 注入 telemetry circuit_break 事件） */
  onCircuitBreak?: (host: string) => void
  /** 可选：fill_form 智能填充规划器（LLM 字段映射；index.ts 注入 provider，自测可替换为桩） */
  formFillPlanner?: (
    fields: FormField[],
    ctx: { vars: Record<string, string>; constraints: string; onlyRequired: boolean }
  ) => Promise<import('./testcase/fields').FormFillItem[]>

  constructor(tabManager: TabManager) {
    this.tabManager = tabManager
  }

  /**
   * 提取页面元素。opts.task（S1 语义重排）：提供时按任务关键词把语义相关元素提前——
   * 重排在 snapshots.set 之前完成，编号即最终编号（快照与提示词一致）。
   * opts.limit（S1 扩展提取）：提高快照上限重提取（默认按设置的上限）。
   */
  async extract(tab?: Tab, opts?: { task?: string; limit?: number }): Promise<ExtractResult> {
    const t = tab || this.tabManager.active()
    if (!t) throw new Error('没有可用页签')
    const cap = opts?.limit ? Math.max(20, Math.min(200, opts.limit)) : this.snapshotLimit()
    let res = await t.cdp.evaluate<ExtractResult>(EXTRACT_FN, [cap])
    if (!res || !Array.isArray(res.candidates)) {
      throw new Error('页面提取结果为空（页面可能还在加载或为特殊页面）')
    }
    if (opts?.task) {
      try {
        res = rerankByTask(res, opts.task)
      } catch {}
    }
    this.snapshots.set(t.id, res)
    return res
  }

  /** S1 扩展提取：任务关键名词一个都没命中候选时，提高上限重提取一次 */
  async extractBoosted(tab: Tab, task: string, limit = 160): Promise<ExtractResult> {
    return this.extract(tab, { task, limit })
  }

  /** 任务关键词是否命中任一候选（语义分 ≥ 0.5）——扩展提取的触发判据 */
  taskHitsCandidate(res: ExtractResult, task: string): boolean {
    if (!task) return false
    return res.candidates.some(
      (c) => scoreCandidate({ text: c.text, extra: c.extra, role: c.role, tag: c.tag }, task).score >= 0.5
    )
  }

  /** 任务关键词列表（runner 日志/扩展提取判据共用） */
  taskKeywords(task: string): string[] {
    return extractKeywords(task)
  }

  private maxElementsProvider: () => number = () => 80

  setMaxElementsProvider(fn: () => number): void {
    this.maxElementsProvider = fn
  }

  private snapshotLimit(): number {
    // 提取时留一点余量，提示词侧再按设置裁剪
    return Math.max(20, Math.min(120, this.maxElementsProvider() + 10))
  }

  getSnapshot(tabId: number): ExtractResult | undefined {
    return this.snapshots.get(tabId)
  }

  /** 页签关闭时清理其提取快照（Map 只增不减会随页签开闭累积泄漏） */
  dropSnapshots(tabId: number): void {
    this.snapshots.delete(tabId)
  }

  /**
   * 格式化元素列表给提示词。keepIdx（S6 本地初筛）：仅渲染这些原始编号的元素
   * （编号保持与快照一致），缺省渲染前 limit 个（与历史行为一致）。
   */
  formatForPrompt(res: ExtractResult, limit: number, withCoords = false, keepIdx?: number[]): string {
    const sliced: ExtractResult = { ...res, candidates: res.candidates.slice(0, limit) }
    return formatCandidates(sliced, withCoords, keepIdx)
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true }
      )
    })
  }

  private humanDelay(settings: Settings, signal: AbortSignal): Promise<void> {
    const ms = settings.speed === 'slow' ? rand(800, 1600) : rand(280, 650)
    return this.sleep(ms, signal)
  }

  /** R2 拟人键入：humanLike 开启时短文本走逐字符通道（cdp.insertTextHuman），长文本整段 */
  private typeHuman(t: Tab, text: string, ctx: ExecContext): Promise<void> {
    if (ctx.settings?.humanLike === false) return t.cdp.insertText(text)
    return t.cdp.insertTextHuman(text)
  }

  /** R2 拟人移动：humanLike 开启时贝塞尔轨迹滑向目标（关闭=直点，回归瞬时操作） */
  private async moveHuman(t: Tab, x: number, y: number, ctx: ExecContext): Promise<void> {
    if (ctx.settings?.humanLike === false) return
    try {
      await t.cdp.moveHumanTo(x, y)
    } catch {}
  }

  /**
   * T5 定位链（W4，P0-1 全量修正）：
   * path 直达 → 容器锚点联合消歧（role+tag ∧ 锚文本，列表行操作不串行）→ text/tag 中心点最近
   * （仅非列表场景，同名重复 >2 个不启用）→ 同 role 就近（同上）→ 坐标兜底（命中护栏 + 写操作禁用）。
   * 虚拟列表（同名重复 >2 = 列表场景）只走语义定位级——位置级就近必点错行。
   * 全部失败时写操作直接报错（错行 = 0 硬线），不猜。
   */
  private async resolveIndex(t: Tab, index: number): Promise<Resolved> {
    const snap = this.snapshots.get(t.id)
    if (!snap || index < 0 || index >= snap.candidates.length) return { found: false }
    const cand = snap.candidates[index]
    const r = await t.cdp.evaluate<Resolved>(RESOLVE_FN, [cand.framePaths, cand.path, cand.tag])
    if (r.found) return { ...r, cand }
    const chainOn = getSettings().locatorChain !== false
    // DOM 变动（SPA 重渲染/虚拟滚动/懒加载占位/节点回收）：重新提取并按定位链重定位
    const fresh = await this.extract(t)
    const cx = cand.rect.x + cand.rect.w / 2
    const cy = cand.rect.y + cand.rect.h / 2
    const dist2 = (c: Candidate) => (c.rect.x + c.rect.w / 2 - cx) ** 2 + (c.rect.y + c.rect.h / 2 - cy) ** 2
    const pickNearest = (filter: (c: Candidate) => boolean): Candidate | undefined => {
      let best: Candidate | undefined
      let bestD = Infinity
      for (const c of fresh.candidates) {
        if (!filter(c)) continue
        const d = dist2(c)
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      return best
    }
    // 列表场景判定：同 tag 同文本（或同 role 同文本）候选 >2 个 = 同名重复长列表/虚拟列表
    const sameNameCount = fresh.candidates.filter(
      (c) => c.text && c.text === cand.text && (c.tag === cand.tag || c.role === cand.role)
    ).length
    const listScenario = sameNameCount > 2
    // 写操作（提交/保存/删除/支付/下单…）：禁裸坐标兜底（P0-1 硬门禁，不可配置绕过）
    const label = `${cand.text || ''} ${cand.extra || ''} ${cand.anchor || ''}`.trim()
    const submitish = isSubmitishLabel(label)

    let c2: Candidate | undefined
    // ② 容器锚点联合消歧（role+tag ∧ 锚文本）：列表行操作的唯一安全级——
    //    排序/插新行后按锚文本锁定原行（Playwright filter({hasText}) 思路）
    if (chainOn && cand.anchor) {
      c2 = pickNearest(
        (c) =>
          (c.tag === cand.tag || c.role === cand.role) &&
          !!c.anchor &&
          c.anchor === cand.anchor &&
          (!cand.text || !c.text || c.text === cand.text || listScenario)
      )
    }
    if (!c2 && !listScenario) {
      // ① tag + 可见文本全等（最抗改版的语义键），中心点最近仲裁
      if (cand.text) {
        c2 = pickNearest((c) => c.tag === cand.tag && c.text === cand.text)
      }
      // ②' 文本线索匹配（label/placeholder/name/aria 任一线索全等即认，同 tag/role 优先）
      if (!c2 && chainOn) {
        const hints = (cand.extra || '')
          .split(/[\s=]/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 2)
        const candExtra = cand.extra || ''
        if (hints.length) {
          c2 = pickNearest(
            (c) =>
              c.extra !== undefined &&
              (c.tag === cand.tag || c.role === cand.role) &&
              (hints.some((h) => (c.extra || '').includes(h)) || (!!candExtra && (c.extra || '') === candExtra))
          )
        }
      }
      // ③ 同 role+tag 就近（页面整体平移/重排，文本也变了时的结构锚；列表场景已禁用）
      if (!c2 && chainOn) {
        c2 = pickNearest((c) => c.role === cand.role && c.tag === cand.tag)
      }
    }
    if (c2) {
      const r2 = await t.cdp.evaluate<Resolved>(RESOLVE_FN, [c2.framePaths, c2.path, c2.tag])
      return r2.found ? { ...r2, cand: c2 } : { found: false }
    }
    // ④ 坐标兜底（命中护栏 + 写操作禁用）：目标大概率仍在原坐标处——
    //    elementFromPoint 校验最上层元素 tag/text 与目标一致才允许，不一致放弃坐标法
    if (chainOn && !submitish && !listScenario) {
      const hit = await t.cdp
        .evaluate<{ ok: boolean; tag?: string; text?: string; reason?: string }>(HIT_TEST_FN, [
          Math.round(cx),
          Math.round(cy),
          cand.tag,
          cand.text || undefined
        ])
        .catch(() => null)
      if (hit?.ok) {
        return { found: true, x: cx, y: cy, tag: hit.tag, w: cand.rect.w, h: cand.rect.h, cand }
      }
      return { found: false }
    }
    return { found: false }
  }

  /* —— T2/W1 自适应熔断（P0-2）：连续 2 次吃满 settle 上限 → 该任务回退固定等待；
     同 host 记忆（风险表：熔断按站点记忆，同 host 二次任务直接回退） —— */
  private settleCapStreak = 0
  private circuitBroken = false
  private static circuitBrokenHosts = new Set<string>()

  /** 清任务级等待熔断状态（新任务开始时重置；host 记忆保留） */
  resetWaitState(): void {
    this.settleCapStreak = 0
    this.circuitBroken = false
  }

  /**
   * 等待页面 settle（P0-2 全量修正版）。
   * - first_screen（首屏导航）：isLoading 结束 + 固定窗口为准——首屏渲染噪声大，不套 mutation 静默；
   * - action（动作批后）：网络静默（in-flight 生命周期） + DOM 结构静默（统一分类表），
   *   慢速模式公式：实际等待 = max(拟人下限, min(信号等待, 上限))；正常模式无拟人下限。
   * - 自适应熔断：同一任务连续 2 次吃满上限 → 回退固定 600/1200ms（telemetry circuit_break）。
   * - 保底固定 sleep 已删除（W1 信号即收敛依据；慢速模式的拟人下限保留）。
   */
  private async waitSettle(
    t: Tab,
    signal: AbortSignal,
    slow: boolean,
    smart = true,
    phase: 'first' | 'action' = 'action',
    onTiming?: (ms: number) => void
  ): Promise<void> {
    const t0 = Date.now()
    const done = () => {
      if (onTiming) onTiming(Date.now() - t0)
    }
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && !signal.aborted) {
      try {
        if (!t.view.webContents.isLoading()) break
      } catch {
        break
      }
      await this.sleep(200, signal)
    }
    // 首屏：isLoading 结束 + 固定窗口（分策略——首屏不套 mutation 静默）
    if (phase === 'first' || !smart || slow) {
      await this.sleep(slow ? 1200 : 600, signal)
      done()
      return
    }
    // 熔断回退（任务级 / host 级记忆）：固定等待，不再吃信号上限
    let host = ''
    try {
      host = new URL(t.url).host
    } catch {}
    if (this.circuitBroken || (host && Executor.circuitBrokenHosts.has(host))) {
      await this.sleep(600, signal)
      done()
      return
    }
    // 信号等待：网络 in-flight 静默（上限 4s） // DOM 结构静默（上限 5s），并行收敛取较慢者
    let ateCap = false
    if (!signal.aborted) {
      const [netQuiet, domQuiet] = await Promise.all([
        t.cdp.waitNetworkQuiet(300, 4000),
        t.cdp.waitDomStable(250, 5000)
      ])
      ateCap = !netQuiet || !domQuiet
    }
    // 自适应熔断：连续 2 次吃满上限 → 该任务（与该 host 的后续任务）回退固定等待
    if (ateCap) {
      this.settleCapStreak++
      if (this.settleCapStreak >= 2 && !this.circuitBroken) {
        this.circuitBroken = true
        if (host) Executor.circuitBrokenHosts.add(host)
        try {
          this.onCircuitBreak?.(host)
        } catch {}
      }
    } else {
      this.settleCapStreak = 0
    }
    done()
  }

  /**
   * 顺序执行一批动作（最多 5 个）。
   * 页签类动作（new_tab/switch_tab/close_tab）之后不再执行后续动作，
   * 强制下一步重新提取新页签的元素。
   */
  async executeBatch(actions: AgentAction[], ctx: ExecContext): Promise<AgentAction[]> {
    const out: AgentAction[] = []
    const needsOverlay =
      actions.some((a) =>
        ['click', 'click_xy', 'type', 'scroll', 'drag', 'paste_rich', 'paste_image'].includes(a.name)
      )
    // 批内发生导航（goto/back/forward）→ 批后 settle 走首屏策略
    let batchHadNav = false
    try {
      if (needsOverlay && this.overlay && !ctx.signal.aborted) await this.overlay.begin()
      for (let i = 0; i < actions.length && i < 5; i++) {
        if (ctx.signal.aborted) break
        const a = { ...actions[i] }
        if (a.name === 'goto' || a.name === 'back' || a.name === 'forward') batchHadNav = true
        try {
          const tabChanged = await this.executeOne(a, ctx)
          out.push(a)
          if (tabChanged) {
            if (i < actions.length - 1) {
              out.push({
                name: 'wait',
                seconds: 0,
                result: '已切换页签，本批剩余动作已跳过（下一步将提取新页签元素）'
              })
            }
            break
          }
        } catch (e: any) {
          a.error = String(e?.message || e).slice(0, 200)
          // T8 反思签名（方式失败才有意义）：动作名 + 目标语义 + 容器锚文本
          if (!a.failSig) {
            const snap = this.snapshots.get(this.tabManager.active()?.id ?? -1)
            const cand = a.index != null ? snap?.candidates[a.index] : undefined
            a.failSig = `${a.name}|${(a.text || cand?.text || cand?.extra || '').slice(0, 24)}|${(cand?.anchor || '').slice(0, 24)}`
          }
          out.push(a)
          break // 出错即停止本批，下一步让模型看到错误并自行调整
        }
        if (i < actions.length - 1) await this.humanDelay(ctx.settings, ctx.signal)
      }
      // 批后等页面稳定（T2：分策略 + settleMs 计时回填）
      const t = this.tabManager.active()
      if (t && !ctx.signal.aborted) {
        await this.waitSettle(
          t,
          ctx.signal,
          ctx.settings.speed === 'slow',
          ctx.settings.smartWait !== false,
          batchHadNav ? 'first' : 'action',
          (ms) => {
            if (ctx.timings) ctx.timings.settleMs = (ctx.timings.settleMs || 0) + ms
          }
        )
      }
    } finally {
      this.overlay?.end()
    }
    return out
  }

  /** 返回 true 表示该动作改变了活动页签 */
  private async executeOne(a: AgentAction, ctx: ExecContext): Promise<boolean> {
    const tm = this.tabManager
    switch (a.name) {
      case 'click': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null) throw new Error('click 需要 index')
        const r = await this.resolveIndex(t, a.index)
        if (!r.found) {
          const snap = this.snapshots.get(t.id)
          const c0 = snap?.candidates[a.index]
          a.failSig = `click|${(c0?.text || c0?.extra || '').slice(0, 24)}|${(c0?.anchor || '').slice(0, 24)}`
          throw new Error(`元素[${a.index}]已失效（页面可能已变化）`)
        }
        if (r.w === 0 || r.h === 0) throw new Error(`元素[${a.index}]不可见`)
        // T5 state 时效：快照的 disabled 是时点值，执行前实时属性再判一次（禁用类误判归零）
        if (r.disabled) throw new Error(`元素[${a.index}]当前为禁用状态，不可点击`)
        // submitish 判定用实际命中候选（重定位后文案可能已不同）+ 容器锚文本
        const cand = r.cand
        const label = `${cand?.text || ''} ${cand?.extra || ''}`.trim()
        const submitish = isSubmitishLabel(label)
        // 测试模式生产保护：提交/删除类点击需人工确认（普通任务 protectedSubmit 恒缺省，零影响）
        if (ctx.protectedSubmit && submitish) {
          const choice = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['允许本次', '拦截'],
            defaultId: 1,
            cancelId: 1,
            message: `生产环境保护：测试即将点击「${label.slice(0, 30)}」`,
            detail: '当前环境被标记为生产保护，请人工确认本次提交可以执行。'
          })
          if (choice.response !== 0) {
            a.result = `已拦截提交类点击「${label.slice(0, 30)}」（生产环境保护）`
            a.error = a.result
            return false
          }
        }
        // T3 零成本命中记录（点击坐标 + 目标 rect）：时间线叠加标记，定位诊断主手段
        if (ctx.hits) {
          ctx.hits.push({
            x: Math.round(r.x!),
            y: Math.round(r.y!),
            w: Math.round(r.w || 0),
            h: Math.round(r.h || 0),
            label: (cand?.text || label).slice(0, 20) || undefined
          })
        }
        // toggle 类目标（checkbox/switch/单选）：点击前记下语义状态，点击后回读（T7 按动作类型分流）
        const isToggle =
          (cand?.role === '复选框' || cand?.role === '单选框' || /switch|checkbox|radio/i.test(cand?.tag || '')) ||
          /switch|toggle/i.test(cand?.role || '')
        const checkedBefore = isToggle ? r.checked : undefined
        await this.sleep(160, ctx.signal)
        if (this.overlay) {
          try {
            await this.overlay.moveTo(r.x!, r.y!)
          } catch {}
        }
        await this.moveHuman(t, r.x!, r.y!, ctx)
        await t.cdp.mouseClick(r.x! + rand(-2, 2), r.y! + rand(-2, 2))
        if (this.overlay) {
          try {
            await this.overlay.click(r.x!, r.y!)
          } catch {}
        }
        a.result = `点击(${Math.round(r.x!)},${Math.round(r.y!)})`
        // T7 toggle 语义回读：勾选/开关状态比对（hover/toast 类不给「无变化」强提示的规则在 runner 侧）
        if (isToggle && r.cand) {
          try {
            const r2 = await t.cdp.evaluate<Resolved>(RESOLVE_FN, [
              r.cand.framePaths,
              r.cand.path,
              r.cand.tag
            ])
            if (r2.found) {
              a.result = `${a.result}（当前${r2.checked ? '已勾选' : '未勾选'}${
                checkedBefore !== undefined && r2.checked === checkedBefore ? '，状态未变化' : ''
              }）`
            }
          } catch {}
        }
        // P0-3 提交类点击：监听「打开新标签」（预览/支付常见）——新页出现则改等新页 settle，
        // 不等旧页静默（旧页可能永不静默）。窗口通常在静默等待期间就触发；静默完成后只留 600ms 宽限
        let openedNewWindow = false
        if (submitish) {
          const winFlag = t.cdp.awaitNewWindow(5000)
          const quietDone = (async () => {
            if (ctx.settings?.smartWait !== false && ctx.settings?.speed !== 'slow') {
              await Promise.all([t.cdp.waitNetworkQuiet(300, 3000), t.cdp.waitDomStable(250, 2500)])
            } else {
              await this.sleep(1200, ctx.signal)
            }
          })()
          openedNewWindow = await Promise.race([
            winFlag,
            quietDone.then(() => Promise.race([winFlag, this.sleep(600, ctx.signal).then(() => false)]))
          ])
          if (openedNewWindow) {
            a.result = `${a.result}（已打开新标签，将在新页继续）`
            return true // 与切换页签同语义：本批剩余动作跳过，下一步提取新页元素
          }
        }
        // 测试模式软断言：提交类点击后检查「可见的」表单校验错误提示——
        // 用例没写这类断言时也能兜住「提交失败但静默通过」（普通任务 softAssert 恒缺省）
        if (ctx.softAssert && submitish && !a.error) {
          if (ctx.settings?.smartWait === false || ctx.settings?.speed === 'slow') {
            await this.sleep(1200, ctx.signal)
          } else {
            await this.sleep(300, ctx.signal) // 信号等待已覆盖，补一小拍让错误提示渲染完
          }
          const soft = await t.cdp
            .evaluate<{ hit: boolean; sel?: string; text?: string }>(SOFT_ERR_FN, [])
            .catch(() => ({ hit: false }) as { hit: boolean; sel?: string; text?: string })
          if (soft?.hit) {
            const msg = `提交后出现校验错误提示: ${soft.text}（${soft.sel}）`
            a.result = `${a.result} ⚠${msg}`
            ctx.softErrors?.push(msg)
          }
        }
        return false
      }
      case 'click_xy': {
        // 视觉兜底：按截图上的归一化坐标（0~1000）点击——元素列表里没有目标时用（canvas/自定义控件/图标按钮）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.x == null || a.y == null) throw new Error('click_xy 需要 x 与 y（截图归一化坐标 0~1000）')
        const nx = Math.max(0, Math.min(1000, a.x)) / 1000
        const ny = Math.max(0, Math.min(1000, a.y)) / 1000
        const vp = await t.cdp
          .evaluate<{ w: number; h: number }>(VIEWPORT_FN, [])
          .catch(() => null as { w: number; h: number } | null)
        const W = vp?.w || 1280
        const H = vp?.h || 720
        const px = Math.round(nx * W)
        const py = Math.round(ny * H)
        // T5 坐标命中护栏（诊断信息）：记录最上层命中元素，时间线命中标记 + 点错时可归因
        const hitInfo = await t.cdp
          .evaluate<{ ok: boolean; tag?: string; text?: string }>(HIT_TEST_FN, [px, py])
          .catch(() => null)
        if (ctx.hits) {
          ctx.hits.push({
            x: px,
            y: py,
            w: 0,
            h: 0,
            label: hitInfo?.tag ? `<${hitInfo.tag}> ${(hitInfo?.text || '').slice(0, 12)}` : '坐标点击'
          })
        }
        if (this.overlay) {
          try {
            await this.overlay.moveTo(px, py)
          } catch {}
        }
        await this.sleep(160, ctx.signal)
        await this.moveHuman(t, px, py, ctx)
        await t.cdp.mouseClick(px + rand(-2, 2), py + rand(-2, 2))
        if (this.overlay) {
          try {
            await this.overlay.click(px, py)
          } catch {}
        }
        a.result = `按截图坐标点击(${Math.round(a.x)},${Math.round(a.y)}) → 视口(${px},${py})`
        return false
      }
      case 'type': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null || a.text == null) throw new Error('type 需要 index 和 text')
        let text = a.text
        // {{记忆键}} 引用替换
        text = text.replace(/\{\{([^}]+)\}\}/g, (_m, k) => ctx.memory[String(k).trim()] ?? '')
        // 单次解析、全链同源：聚焦坐标 / framePaths+path 赋值回读 / 字段标签判定
        // 全部消费同一份解析候选（重定位后旧快照序号不可再信——P0-1 分裂根因）
        const r = await this.resolveIndex(t, a.index)
        if (!r.found || !r.cand) throw new Error(`元素[${a.index}]已失效（页面可能已变化）`)
        const { framePaths, path } = r.cand
        await this.focusResolved(t, r, ctx)

        // 1) 真实键入：Ctrl+A 全选后走输入法通道替换（trusted 输入管线，框架渲染的站点最买账）
        //    R2 拟人化：短文本逐字符输入（humanLike 可关），长文本自动整段
        await t.cdp.keySelectAll()
        await this.sleep(60, ctx.signal)
        await this.typeHuman(t, text, ctx)
        await this.sleep(140, ctx.signal)

        // 2) 验证实际值
        const readBack = async () => {
          try {
            return await t.cdp.evaluate<{ ok: boolean; value?: string }>(READ_VALUE_FN, [framePaths, path])
          } catch {
            return { ok: false } as { ok: boolean; value?: string }
          }
        }
        let vr = await readBack()
        let how = '真实键入'
        if (!(vr.ok && vr.value === text)) {
          // 3) 兜底：原生 setter + input/change 事件（React 受控组件可感知）
          const setRes = await t.cdp.evaluate<{ ok: boolean; kind?: string }>(SET_VALUE_FN, [framePaths, path, text])
          if (setRes.ok && setRes.kind === 'editable') {
            await t.cdp.insertText(text)
          }
          await this.sleep(120, ctx.signal)
          vr = await readBack()
          how = setRes.ok ? '原生赋值' : '输入法通道'
        }

        if (vr.ok && vr.value === text) {
          a.result = `已输入"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"(${how})`
          // S1 填后语义校验：填对了值 ≠ 填对了字段（静默错误显式化——S1 中价值最高的一步）
          // 校验失败不清空已填值、只报错供模型换候选重填（diagnose 归类为 semantic 自愈）
          if (ctx.settings?.semanticVerify !== false && ctx.task) {
            const lr = await t.cdp
              .evaluate<{ found: boolean; label?: string; placeholder?: string; name?: string; aria?: string; adjacent?: string }>(
                READ_LABEL_FN,
                [framePaths, path]
              )
              .catch(() => null)
            if (lr?.found) {
              const parts = [lr.label, lr.placeholder, lr.name, lr.aria, lr.adjacent].filter(Boolean).map(String)
              // 只有长邻近文本、无短标签时跳过校验（行文本混多个字段名，误报率高）
              const short = parts.filter((p) => p.length <= 14)
              if (parts.length && short.length) {
                const v = verifyFieldMatch(short, ctx.task)
                if (!v.ok && v.want) {
                  a.error = `疑似填错字段：目标「${v.want}」但实际字段是「${short.join(' ').slice(0, 20)}」（相似度 ${Math.round(v.score * 100)}%），请改选更匹配的输入框`
                } else {
                  // S5 经验沉淀 A：语义校验通过 → 记一条站点字段映射（同域同意图幂等合并）
                  if (ctx.settings?.autoExperience !== false && v.score >= 0.5 && v.want && short[0]) {
                    try {
                      upsertExperience({
                        domain: hostOf(ctx.url || ''),
                        kind: 'field_map',
                        key: v.want,
                        value: short[0].slice(0, 30)
                      })
                    } catch {}
                  }
                }
              }
            }
          }
        } else if (vr.ok) {
          // 实际值与目标不一致：如实报告给模型，便于下一步自纠错
          const actual = (vr.value || '').slice(0, 30)
          a.result = actual ? `输入不完整(${how})，实际为"${actual}"，目标"${text.slice(0, 30)}"` : `输入未生效(${how})，输入框仍为空`
          a.error = a.result
        } else {
          // 回读失败（元素已从 DOM 消失/iframe 卸载）：效果无法证实，按失败上报，
          // 否则会污染 repeat 重放与混合模式"上一步全成功"门禁
          a.result = `已输入(输入法通道，无法回读验证)`
          a.error = '输入结果无法回读验证（目标元素可能已失效）'
        }
        return false
      }
      case 'paste_rich': {
        // 富文本写入文档：Markdown → HTML → 剪贴板 → 真实粘贴（光标处，不清空已有内容）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.text == null || !a.text.trim()) throw new Error('paste_rich 需要 text（Markdown 内容）')
        const md = a.text.replace(/\{\{([^}]+)\}\}/g, (_m, k) => ctx.memory[String(k).trim()] ?? '')
        const html = mdToHtml(md)
        const plain = mdToPlain(md)
        const wc = t.view.webContents
        if (wc.isDestroyed()) throw new Error('页面已销毁')
        await Promise.race([
          clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': plain })]),
          clipboardWriteTimeout()
        ])
        if (a.index != null) await this.focusTarget(t, a.index, ctx)
        wc.paste()
        await this.sleep(500, ctx.signal)
        a.result = `已粘贴富文本（${plain.length}字，标题/列表/加粗等样式已转换）`
        return false
      }
      case 'paste_image': {
        // 真实嵌入图片到文档/编辑器：下载图片 → 剪贴板 → 粘贴（文档平台自动上传嵌入），
        // 严禁把图片 URL 当文字 type（那只会留下一条链接文本）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (!a.url) throw new Error('paste_image 需要 url（先用 extract_images 获取图片链接）')
        const wc = t.view.webContents
        if (wc.isDestroyed()) throw new Error('页面已销毁')
        // URL 规范化：协议相对/相对地址
        let url = a.url.trim()
        if (url.startsWith('//')) url = 'https:' + url
        else if (!/^(https?:|data:|blob:)/i.test(url)) {
          try {
            url = new URL(url, wc.getURL()).href
          } catch {
            throw new Error(`图片地址无效: ${url.slice(0, 80)}`)
          }
        }
        // 下载：http(s) 先走页签会话（带登录态 Cookie + Referer 防盗链），失败或 data:/blob: 走全局 fetch
        const buf = await this.downloadImage(url, wc, ctx)
        let nat = nativeImage.createFromBuffer(buf)
        if (nat.isEmpty()) {
          // nativeImage 只解 PNG/JPEG：webp（淘宝主图常见 xxx.jpg_.webp）/gif/bmp 交给 Chromium 画布解码
          try {
            nat = nativeImage.createFromBuffer(await decodeImageToPng(buf))
          } catch (e: any) {
            throw new Error(
              `图片解码失败: ${e?.message || e}。请在当前位置写「（图片获取失败）」占位并按顺序继续后续内容，全部完成后再统一重试失败项，不要回头改动已写内容`
            )
          }
        }
        if (nat.isEmpty())
          throw new Error('图片解码失败。请在当前位置写「（图片获取失败）」占位并按顺序继续，不要回头改动已写内容')
        const size = nat.getSize()
        await Promise.race([
          clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(nat.toPNG())], { type: 'image/png' }) })]),
          clipboardWriteTimeout()
        ])
        if (a.index != null) await this.focusTarget(t, a.index, ctx)
        wc.paste()
        await this.sleep(900, ctx.signal)
        a.result = `已嵌入图片 ${size.width}x${size.height}（若文档未显示，请确认光标在文档正文内后重试）`
        return false
      }
      case 'scroll': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        const dir = a.direction || 'down'
        if (dir === 'top' || dir === 'bottom') {
          await t.cdp.evaluate(SCROLL_FN, [dir])
          await this.sleep(rand(200, 500), ctx.signal) // R2 滚完停顿"看一眼"
        } else {
          const amount = Math.min(Math.max(a.amount || 3, 1), 10)
          const vh = 500
          const dy = (dir === 'down' ? 1 : -1) * amount * 350
          // R2 拟人滚动：缓入缓出 + 随机抖动 + 末端轻微回弹（关闭 humanLike 时保持旧固定步长）
          if (ctx.settings?.humanLike !== false) {
            await t.cdp.scrollHuman(400, vh, dy)
            await t.cdp.mouseWheel(400, vh, 0, -Math.round(rand(10, 30))) // 惯性回弹
          } else {
            for (let k = 0; k < amount; k++) {
              if (ctx.signal.aborted) break
              await t.cdp.mouseWheel(400, vh, 0, (dy / amount) | 0)
              await this.sleep(120, ctx.signal)
            }
          }
        }
        a.result = `滚动 ${dir}`
        return false
      }
      case 'drag': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null) throw new Error('drag 需要 index')
        const r = await this.resolveIndex(t, a.index)
        if (!r.found) throw new Error(`元素[${a.index}]已失效（页面可能已变化）`)
        if (r.w === 0 || r.h === 0) throw new Error(`元素[${a.index}]不可见`)

        // 计算拖动终点：index2 目标元素 / direction+amount 位移（默认向右拖到头）
        let dx = 0
        let dy = 0
        if (a.index2 != null) {
          const r2 = await this.resolveIndex(t, a.index2)
          if (!r2.found) throw new Error(`目标元素[${a.index2}]已失效`)
          dx = r2.x! - r.x!
          dy = r2.y! - r.y!
        } else {
          const dir = a.direction || 'right'
          const dist = Math.min(Math.max(a.amount || 500, 20), 1200)
          dx = dir === 'left' ? -dist : dir === 'right' ? dist : 0
          dy = dir === 'up' ? -dist : dir === 'down' ? dist : 0
        }

        await this.sleep(180, ctx.signal)
        const sx = r.x! + rand(-1, 1)
        const sy = r.y! + rand(-1, 1)
        // 1) 光标滑到起点 → 按下（按下涟漪）
        if (this.overlay) {
          try {
            await this.overlay.moveTo(r.x!, r.y!)
          } catch {}
        }
        await t.cdp.mouseDown(sx, sy)
        if (this.overlay) {
          try {
            await this.overlay.click(r.x!, r.y!)
          } catch {}
        }
        await this.sleep(rand(120, 220), ctx.signal)
        // 2) 分步拖动（带垂直微抖，更像人手），光标拖尾实时跟随
        const steps = Math.max(6, Math.min(18, Math.round(Math.hypot(dx, dy) / 32)))
        const ex = sx + dx
        const ey = sy + dy
        for (let i = 1; i <= steps; i++) {
          if (ctx.signal.aborted) break
          const p = i / steps
          const ease = p < 0.35 ? p * p / 0.35 * 0.7 : 0.7 + ((p - 0.35) / 0.65) * 0.3 // 先慢后快再收
          const px = sx + (ex - sx) * ease + rand(-1.2, 1.2)
          const py = sy + (ey - sy) * ease + rand(-2, 2)
          await t.cdp.mouseDragMove(px, py)
          if (this.overlay) {
            try {
              await this.overlay.dragStep(px, py)
            } catch {}
          } else {
            await this.sleep(rand(40, 80), ctx.signal)
          }
        }
        await this.sleep(rand(100, 200), ctx.signal)
        // 3) 松开（松开涟漪）
        await t.cdp.mouseUp(ex, ey)
        if (this.overlay) {
          try {
            await this.overlay.click(ex, ey)
          } catch {}
        }
        a.result = a.index2 != null ? `拖动[${a.index}]→[${a.index2}]` : `拖动 ${a.direction || 'right'} ${Math.round(Math.hypot(dx, dy))}px`
        return false
      }
      case 'goto': {
        if (!a.url) throw new Error('goto 需要 url')
        let url = a.url.trim()
        if (!/^https?:|^file:/i.test(url)) url = 'https://' + url.replace(/^\/+/, '')
        await tm.navigate(url)
        a.result = `打开 ${url.slice(0, 80)}`
        return false
      }
      case 'back': {
        tm.goBack()
        a.result = '后退'
        return false
      }
      case 'forward': {
        tm.goForward()
        a.result = '前进'
        return false
      }
      case 'wait': {
        const s = Math.min(Math.max(a.seconds ?? 2, 0.5), 15)
        await this.sleep(s * 1000, ctx.signal)
        a.result = `等待 ${s}s`
        return false
      }
      case 'wait_for': {
        // W1 智能等待原语：等业务信号出现再继续（比 wait 盲等快且稳）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        const kind = String(a.kind || 'text_visible')
        const val = String(a.value ?? a.text ?? '')
          .replace(/\{\{([^}]+)\}\}/g, (_m, k) => ctx.memory[String(k).trim()] ?? _m)
          .trim()
        if (!val) throw new Error('wait_for 需要 value（等待的文字/选择器/URL 片段）')
        const budget = Math.min(Math.max(a.seconds ?? 8, 1), 30) * 1000
        // P0-3 未来监听模式：network 类注册 URL 匹配器，等**未来**出现的匹配请求完结并判 status——
        // 查历史缓冲会被后续请求冲刷，只作超时后的兜底（如实标注来源）
        if (kind === 'network') {
          t.cdp.setNetQuietWatch(true) // 确保网络跟踪已开（smartWait 关闭时也有效）
          const hit = await t.cdp.waitForResponse({ urlPart: val, method: a.method }, budget)
          if (!hit) {
            a.result = `等待超时(${Math.round(budget / 1000)}s)未见 URL 含 "${val.slice(0, 40)}" 的接口响应，请检查请求是否发出`
            a.error = a.result
          } else if (hit.status >= 400) {
            // 4xx/5xx 判该步失败（业务失败：可修正后重试，T8 不进禁止清单）
            a.result = `接口响应异常: HTTP ${hit.status}（${hit.url.slice(0, 60)}${hit.stale ? '，兜底:历史缓冲命中' : ''}）`
            a.error = a.result
          } else {
            a.result = `已等到接口响应 HTTP ${hit.status}（${hit.url.slice(0, 50)}${hit.stale ? '，兜底:历史缓冲命中' : ''}）`
          }
          return false
        }
        const deadline = Date.now() + budget
        let ok = false
        let detail = ''
        while (!ok && Date.now() < deadline && !ctx.signal.aborted) {
          try {
            if (kind === 'text_visible') {
              const r = await t.cdp.evaluate<{ found: boolean; snippet: string }>(EXPECT_TEXT_FN, [val])
              ok = !!r?.found
              detail = r?.snippet || ''
            } else if (kind === 'selector_exists') {
              const r = await t.cdp.evaluate<{ ok: boolean; count?: number }>(EXPECT_SEL_FN, [val, 'exists'])
              ok = (r?.count || 0) > 0
              detail = `匹配 ${r?.count || 0} 个`
            } else if (kind === 'url_contains') {
              const u = t.view.webContents.getURL()
              ok = u.includes(val)
              detail = u.slice(0, 60)
            } else {
              throw new Error(`未知 wait_for 类型 ${kind}（可用: text_visible/selector_exists/url_contains/network）`)
            }
          } catch (e: any) {
            if (String(e?.message || e).includes('未知 wait_for')) throw e
            detail = String(e?.message || e).slice(0, 60)
          }
          if (!ok) await this.sleep(400, ctx.signal)
        }
        if (ok) {
          a.result = `已等到 ${kind}="${val.slice(0, 40)}"${detail ? `（${detail.slice(0, 40)}）` : ''}`
        } else {
          a.result = `等待超时(${Math.round(budget / 1000)}s)未出现 ${kind}="${val.slice(0, 40)}"，请检查页面状态后决定重试还是换条件`
          a.error = a.result
        }
        return false
      }
      case 'repeat': {
        // 重放上一批动作（翻页/批量同类操作提速）：页面模式稳定才有意义，动作出错自动停
        const times = Math.min(Math.max(a.amount ?? 2, 1), 10)
        const prev = (ctx.prevActions || []).filter((p) => p.name !== 'repeat' && p.name !== 'done')
        if (!prev.length) throw new Error('repeat 需要上一步有可重放的动作')
        let rounds = 0
        let stopErr: string | null = null
        for (let i = 0; i < times; i++) {
          if (ctx.signal.aborted) break
          for (const p of prev) {
            if (ctx.signal.aborted) break
            const one: AgentAction = { ...p, result: undefined, error: undefined }
            try {
              await this.executeOne(one, ctx)
            } catch (e: any) {
              one.error = e?.message || String(e)
            }
            if (one.error) {
              stopErr = one.error
              break
            }
          }
          if (stopErr) break
          rounds++
          if (i < times - 1) await this.sleep(320, ctx.signal)
        }
        a.result = stopErr
          ? `重放 ${rounds}/${times} 轮后停止：${stopErr.slice(0, 120)}`
          : `已重放 ${times} 轮（每轮 ${prev.length} 个动作）`
        if (rounds === 0 && stopErr) a.error = `repeat 首轮即失败：${stopErr.slice(0, 150)}`
        return false
      }
      case 'read_content': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        const r = await t.cdp.evaluate<{
          title: string
          url: string
          text: string
          bodyLen: number
          imgs: number
        }>(READ_CONTENT_FN, [6000])
        let text = r.text || '(页面没有可读文本)'
        if (r.bodyLen < 100) {
          if (r.imgs > 0) {
            text += `\n(注意: 正文文本很少(${r.bodyLen}字)但有 ${r.imgs} 张图片，页面可能是图片型内容)`
          }
          if (this.ocrPageFallback) {
            try {
              const ocrText = await this.ocrPageFallback()
              if (ocrText) text += `\n\n# OCR 整页识别结果\n${ocrText}`
            } catch {}
          }
        }
        a.result = text.slice(0, 6200)
        // R2 阅读停顿：真人读完才动——按内容长度追加 400-900ms（humanLike 可关）
        if (ctx.settings?.humanLike !== false) {
          await this.sleep(Math.min(900, 400 + a.result.length / 8), ctx.signal)
        }
        return false
      }
      case 'extract_images': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        // 抓取页面图片资源链接（主图/详情图：DOM + 网络嗅探 Performance 资源合并，按尺寸排序）
        const r = await t.cdp.evaluate<string>(EXTRACT_IMAGES_FN, [40])
        a.result = (r || '').slice(0, 6200)
        return false
      }
      case 'save': {
        if (!a.key || a.value == null) throw new Error('save 需要 key 和 value')
        ctx.memory[a.key] = a.value.slice(0, 4000)
        a.result = `已保存 ${a.key}`
        return false
      }
      case 'recall': {
        if (!a.key) throw new Error('recall 需要 key')
        const v = ctx.memory[a.key]
        a.result = v == null ? `记忆中没有 "${a.key}"` : `${a.key}=${v.slice(0, 1500)}`
        return false
      }
      case 'new_tab': {
        const before = tm.active()?.id
        const res = tm.newTab(a.url || undefined)
        if (res.activeTabId === before) {
          a.result = '新建页签失败：已达 5 个上限'
        } else {
          a.result = a.url ? `新页签打开 ${a.url.slice(0, 60)}` : '已新建空白页签'
        }
        return true
      }
      case 'switch_tab': {
        const idx = a.index ?? 1
        const tabs = tm.all()
        if (idx < 1 || idx > tabs.length) throw new Error(`页签序号 ${idx} 不存在（当前共 ${tabs.length} 个）`)
        tm.switchTab(tabs[idx - 1].id)
        a.result = `切换到页签${idx}(${tabs[idx - 1].title.slice(0, 20)})`
        return true
      }
      case 'close_tab': {
        const idx = a.index ?? 1
        const tabs = tm.all()
        if (idx < 1 || idx > tabs.length) throw new Error(`页签序号 ${idx} 不存在`)
        const closing = tabs[idx - 1]
        tm.closeTab(closing.id)
        a.result = `关闭页签${idx}(${closing.title.slice(0, 20)})`
        return true
      }
      case 'expect': {
        // 测试断言：失败不抛错（写入 a.error），同批后续动作照常执行；
        // 3s 内每 500ms 轮询重试（SPA 异步渲染容错）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (!a.kind) throw new Error('expect 需要 kind')
        const expectVal = String(a.value ?? a.text ?? '').replace(
          /\{\{([^}]+)\}\}/g,
          (_m, k) => ctx.memory[String(k).trim()] ?? _m
        )
        const deadline = Date.now() + 3000
        let passed = false
        let actual = ''
        while (true) {
          try {
            if (a.kind === 'url_contains') {
              actual = t.view.webContents.getURL()
              passed = actual.includes(expectVal)
            } else if (a.kind === 'title_contains') {
              actual = t.view.webContents.getTitle()
              passed = actual.includes(expectVal)
            } else if (a.kind === 'text_visible') {
              const r = await t.cdp.evaluate<{ found: boolean; snippet: string }>(EXPECT_TEXT_FN, [expectVal])
              passed = !!r?.found
              actual = r?.snippet || (passed ? '已命中' : '页面文本中未找到')
            } else if (a.kind === 'selector_exists') {
              const r = await t.cdp.evaluate<{ ok: boolean; count?: number; err?: string }>(EXPECT_SEL_FN, [
                a.selector || '',
                'exists'
              ])
              if (!r?.ok) {
                actual = r?.err || '选择器无效'
                passed = false
              } else {
                actual = `匹配 ${r.count || 0} 个元素`
                passed = (r.count || 0) > 0
              }
            } else if (a.kind === 'selector_value' || a.kind === 'selector_text') {
              const r = await t.cdp.evaluate<{ ok: boolean; count?: number; v?: string; err?: string }>(EXPECT_SEL_FN, [
                a.selector || '',
                a.kind === 'selector_value' ? 'value' : 'text'
              ])
              if (!r?.ok) {
                actual = r?.err || '选择器无效'
                passed = false
              } else if (!r.count) {
                actual = '选择器未匹配到元素'
                passed = false
              } else {
                actual = r.v || '(空)'
                passed = actual.trim() === expectVal.trim()
              }
            } else if (a.kind === 'api_status' || a.kind === 'api_body') {
              // 网络级断言：按 URL 片段匹配最近一次请求（外层 3s 轮询容错「请求还在飞」）
              const urlPart = String(a.urlPart || '').replace(
                /\{\{([^}]+)\}\}/g,
                (_m, k) => ctx.memory[String(k).trim()] ?? _m
              )
              if (!urlPart) {
                actual = '缺少 URL 片段'
                passed = false
              } else {
                const r = await t.cdp.findResponseBody(urlPart)
                if (!r) {
                  passed = false
                  actual = `未捕获到 URL 含 "${urlPart}" 的接口请求`
                } else if (a.kind === 'api_status') {
                  actual = `HTTP ${r.status} (${r.url.slice(0, 60)})`
                  passed = String(r.status) === String(expectVal)
                } else {
                  const body = r.body || ''
                  passed = body.includes(expectVal)
                  actual = body ? body.slice(0, 100) : '(无响应体/缓冲已回收)'
                }
              }
            } else {
              throw new Error(`未知断言类型 ${a.kind}`)
            }
          } catch (e: any) {
            actual = String(e?.message || e)
            passed = false
          }
          if (a.negate) passed = !passed
          if (passed || Date.now() >= deadline || ctx.signal.aborted) break
          await this.sleep(500, ctx.signal)
        }
        const desc = `${a.negate ? '不' : ''}${expectVal || a.selector}`
        if (passed) {
          a.result = `断言通过: [${a.kind}] ${desc}`
        } else {
          a.error = `断言失败: [${a.kind}] 期望=${desc} 实际=${actual.slice(0, 120)}`
          a.result = a.error
        }
        return false
      }
      case 'fill_form': {
        // 智能表单填充：字段深提取（含无 label 字段的语义线索）→ LLM 规划「字段→值」映射
        // → 逐字段确定性填充（真实键入+回读验证 / select、checkbox 专用设置）
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        const fields = await t.cdp.evaluate<FormField[]>(FORM_FIELDS_FN, [])
        if (!fields || !fields.length) throw new Error('页面上没有找到表单字段')
        let plan: import('./testcase/fields').FormFillItem[]
        if (a.data && Object.keys(a.data).length) {
          // 显式映射：按「字段描述」在语义线索里匹配
          plan = []
          const unmatched: string[] = []
          for (const [desc, val] of Object.entries(a.data)) {
            const d = desc.trim()
            const idx = fields.findIndex(
              (f) => [f.label, f.name, f.id, f.placeholder, f.aria].some((x) => x && (x === d || x.includes(d))) || f.hint.includes(d)
            )
            if (idx >= 0) plan.push({ index: idx, value: String(val), reason: '显式指定' })
            else unmatched.push(desc)
          }
          if (unmatched.length) throw new Error(`显式映射未命中的字段: ${unmatched.join('、').slice(0, 100)}`)
        } else {
          if (!this.formFillPlanner) throw new Error('智能填充规划器未配置（请先在设置中配置 AI 接口）')
          plan = await this.formFillPlanner(fields, {
            vars: ctx.memory,
            constraints: (a.text || '').slice(0, 300),
            onlyRequired: !!a.onlyRequired
          })
        }
        // 填充预览模式：AI 推断的「字段→值」映射先人工确认再执行（首次跑陌生站点建议开）
        if (ctx.fillPreview) {
          const preview = plan
            .slice(0, 30)
            .map((p) => {
              const f = fields[p.index]
              const name = f ? (f.label || f.placeholder || f.name || f.id || `#${p.index}`) : `#${p.index}`
              return `${name} = ${p.value || '(勾选:' + (p.check ? '是' : '否') + ')'}${p.reason ? `  ← ${p.reason}` : ''}`
            })
            .join('\n')
          const choice = await dialog.showMessageBox({
            type: 'info',
            buttons: ['执行填充', '取消'],
            defaultId: 0,
            cancelId: 1,
            message: '智能填充预览（确认后开始填充）',
            detail: preview.slice(0, 900)
          })
          if (choice.response !== 0) throw new Error('智能填充已被人工取消（预览模式）')
        }
        const lines: string[] = []
        let fails = 0
        for (const item of plan) {
          if (ctx.signal.aborted) break
          const f = fields[item.index]
          if (!f) continue
          try {
            lines.push(await this.fillField(t, f, item.value, item.check, ctx, item.reason))
          } catch (e: any) {
            fails++
            lines.push(`✗ ${e?.message || e}`)
          }
          await this.humanDelay(ctx.settings, ctx.signal)
        }
        a.result = `智能填充 ${plan.length - fails}/${plan.length} 个字段:\n` + lines.slice(0, 20).join('\n')
        if (fails) a.error = `${fails} 个字段填充未通过回读验证`
        return false
      }
      case 'hover': {
        // 悬停展开（导航下拉等 hover 菜单）：无按键 mouseMoved 触发 CSS :hover / mouseenter
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null) throw new Error('hover 需要 index')
        const r = await this.resolveIndex(t, a.index)
        if (!r.found) throw new Error(`元素[${a.index}]已失效（页面可能已变化）`)
        if (r.w === 0 || r.h === 0) throw new Error(`元素[${a.index}]不可见`)
        await this.sleep(140, ctx.signal)
        const x = r.x! + rand(-2, 2)
        const y = r.y! + rand(-2, 2)
        if (this.overlay) {
          try {
            await this.overlay.moveTo(x, y)
          } catch {}
        }
        await t.cdp.mouseHover(x, y)
        await this.sleep(180, ctx.signal)
        // 同点微移一次，确保 hover 状态稳定建立
        await t.cdp.mouseHover(x + 1, y + 1)
        await this.sleep(120, ctx.signal)
        a.result = `悬停(${Math.round(x)},${Math.round(y)})`
        return false
      }
      case 'upload': {
        // 文件上传：CDP DOM.setFileInputFiles（input[type=file] 只能这样喂文件，
        // type/insertText 均无效）。路径支持 {{变量}}（测试数据表 @路径 约定）。
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null) throw new Error('upload 需要 index')
        if (!a.path) throw new Error('upload 需要 path（本地文件路径）')
        let p = a.path.replace(/\{\{([^}]+)\}\}/g, (_m, k) => ctx.memory[String(k).trim()] ?? _m)
        if (p.startsWith('@')) p = p.slice(1)
        p = p.replace(/^"|"$/g, '')
        if (!existsSync(p)) throw new Error(`文件不存在: ${p}`)
        const st = statSync(p)
        if (!st.isFile()) throw new Error(`不是文件: ${p}`)
        if (st.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 上限')
        // 解析与路径同源（重定位后旧快照序号不可信，见 resolveIndex）
        const rr = await this.resolveIndex(t, a.index)
        if (!rr.found || !rr.cand) throw new Error(`元素[${a.index}]不存在`)
        const framePaths = rr.cand.framePaths
        const path = rr.cand.path
        const objectId = await t.cdp.evaluateRef(UPLOAD_FIND_FN, [framePaths, path])
        if (!objectId) throw new Error(`元素[${a.index}]未找到（应为 input[type=file]）`)
        // DOM 域命令需先 enable；requestNode 还要求 DOM agent 已拉取过文档（否则 nodeId=0）
        await t.cdp.send('DOM.enable', {})
        // 首选：现代协议支持 objectId 直传
        let set = false
        try {
          await t.cdp.send('DOM.setFileInputFiles', { files: [p], objectId })
          set = true
        } catch {
          /* 旧协议回退 nodeId 路径 */
        }
        if (!set) {
          await t.cdp.send('DOM.getDocument', { depth: 0 })
          const node = await t.cdp.send<{ nodeId: number }>('DOM.requestNode', { objectId })
          if (!node?.nodeId) throw new Error('DOM.requestNode 未返回 nodeId')
          await t.cdp.send('DOM.setFileInputFiles', { files: [p], nodeId: node.nodeId })
        }
        // 回读确认文件真的挂上了（CDP 命令成功≠生效）
        const upCount = await t.cdp.evaluate<number>(UPLOAD_COUNT_FN, [framePaths, path]).catch(() => -1)
        if (upCount === 0) throw new Error('文件未挂载到 input[type=file]（setFileInputFiles 未生效）')
        a.result = `已选择文件 ${p.split(/[\\/]/).pop()}（${Math.round(st.size / 1024)}KB）`
        return false
      }
      case 'clarify': {
        // S4 不确定时向人工提问：runner 在批前拦截（暂停任务+通知人工），这里只是
        // 兜底 no-op（防 repeat 重放等边缘路径把未知动作抛错）
        a.result = a.result || `已向人工提问: ${(a.query || '').slice(0, 60)}`
        return false
      }
      case 'test_step_done': {
        // 测试步骤完成标记（runner 通常在执行前拦截推进指针；这里兜底为无害 no-op，
        // 防 repeat 重放等边缘路径把未知动作抛错）
        a.result = a.result || '测试步骤完成'
        return false
      }
      case 'done': {
        a.result = a.result || a.value || '任务完成'
        return false
      }
      default:
        throw new Error(`未知动作 ${(a as AgentAction).name}`)
    }
  }

  /** type / paste 系动作共用的「按编号解析元素 → trusted 点击聚焦」（带光标可视化） */
  /** 聚焦已解析元素（trusted 点击聚焦）。调用方必须先 resolveIndex 并传入同一份
   *  解析结果——再解析一次就多一次漂移机会，type 的赋值路径与聚焦点必须同源 */
  private async focusResolved(t: Tab, r: Resolved, ctx: ExecContext): Promise<void> {
    await this.sleep(160, ctx.signal)
    if (this.overlay) {
      try {
        await this.overlay.moveTo(r.x!, r.y!)
      } catch {}
    }
    await this.moveHuman(t, r.x!, r.y!, ctx)
    // 先点击聚焦（trusted mousedown 对站点脚本可见）
    await t.cdp.mouseClick(r.x! + rand(-2, 2), r.y! + rand(-2, 2))
    if (this.overlay) {
      try {
        await this.overlay.click(r.x!, r.y!)
      } catch {}
    }
    await this.sleep(220, ctx.signal)
  }

  private async focusTarget(t: Tab, index: number, ctx: ExecContext): Promise<void> {
    const r = await this.resolveIndex(t, index)
    if (!r.found) throw new Error(`元素[${index}]已失效（页面可能已变化）`)
    await this.focusResolved(t, r, ctx)
  }

  /** 下载图片字节：http(s) 优先走页签会话（带站点登录态），失败或 data:/blob: 走全局 fetch；支持中断与 20s 超时 */
  private async downloadImage(url: string, wc: WebContents, ctx: ExecContext): Promise<Buffer> {
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    if (ctx.signal.aborted) throw new Error('已中止')
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), 20000)
    const cleanup = () => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
    try {
      // Referer 用当前页面地址：alicdn 等图床有防盗链，缺 Referer 会 403
      const referer = (() => {
        try {
          return wc.getURL()
        } catch {
          return ''
        }
      })()
      const headers = referer ? { Referer: referer } : undefined
      if (/^https?:/i.test(url)) {
        try {
          const r = await wc.session.fetch(url, { signal: ctl.signal, headers } as any)
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer())
            if (buf.length) return buf
          }
        } catch {}
      }
      const r = await fetch(url, { signal: ctl.signal, headers } as any)
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) throw new Error('图片内容为空')
      return buf
    } finally {
      cleanup()
    }
  }

  /** type 动作用：按快照取元素的 framePaths/path */

  /**
   * fill_form 单字段填充（与 type 动作同质量的管线，但按 paths 直达字段）：
   * select/checkbox 走 FORM_SET_FN；文本类走 真实点击聚焦→Ctrl+A→输入法通道→回读验证→原生 setter 兜底。
   * 返回一行人类可读结果；失败抛错（含字段语义标签，便于时间线/报告审计）。
   */
  private async fillField(
    t: Tab,
    f: FormField,
    value: string,
    check: boolean | undefined,
    ctx: ExecContext,
    reason?: string
  ): Promise<string> {
    const label = (f.label || f.placeholder || f.name || f.id || f.adjacent || `字段@${f.path.slice(-2).join('.')}`).slice(0, 24)
    const why = reason ? `(${reason})` : ''
    if (f.tag === 'SELECT') {
      const r = await t.cdp.evaluate<{ ok: boolean; set?: string; err?: string }>(FORM_SET_FN, [
        f.framePaths,
        f.path,
        'select',
        value,
        false
      ])
      if (!r?.ok) throw new Error(`下拉「${label}」选项未命中(${r?.err || '失败'})${why}`)
      return `✓ 下拉 ${label} → ${r.set}${why}`
    }
    if (f.inputType === 'checkbox' || f.inputType === 'radio') {
      const want = check ?? true
      const r = await t.cdp.evaluate<{ ok: boolean; set?: string }>(FORM_SET_FN, [
        f.framePaths,
        f.path,
        'check',
        '',
        want
      ])
      if (!r?.ok) throw new Error(`勾选「${label}」设置失败${why}`)
      return `✓ ${f.inputType === 'radio' ? '单选' : '勾选'} ${label} → ${r.set}${why}`
    }
    const r = await t.cdp.evaluate<Resolved>(RESOLVE_FN, [f.framePaths, f.path, f.tag])
    if (!r.found || r.x == null || r.y == null) throw new Error(`字段「${label}」已失效${why}`)
    await this.sleep(140, ctx.signal)
    await this.moveHuman(t, r.x, r.y, ctx)
    await t.cdp.mouseClick(r.x + rand(-2, 2), r.y + rand(-2, 2))
    await this.sleep(200, ctx.signal)
    await t.cdp.keySelectAll()
    await this.sleep(60, ctx.signal)
    await this.typeHuman(t, value, ctx)
    await this.sleep(160, ctx.signal)
    const vr = await t.cdp
      .evaluate<{ ok: boolean; value?: string }>(READ_VALUE_FN, [f.framePaths, f.path])
      .catch(() => ({ ok: false }) as { ok: boolean; value?: string })
    if (vr?.ok && vr.value === value) return `✓ ${label} = "${value.slice(0, 24)}"(真实键入)${why}`
    // 兜底：原生 setter + input/change 事件（React 受控组件可感知）
    await t.cdp.evaluate(SET_VALUE_FN, [f.framePaths, f.path, value]).catch(() => {})
    await this.sleep(160, ctx.signal)
    const vr2 = await t.cdp
      .evaluate<{ ok: boolean; value?: string }>(READ_VALUE_FN, [f.framePaths, f.path])
      .catch(() => ({ ok: false }) as { ok: boolean; value?: string })
    if (vr2?.ok && vr2.value === value) return `✓ ${label} = "${value.slice(0, 24)}"(原生赋值)${why}`
    const got = vr2?.ok ? `"${(vr2.value || '').slice(0, 20)}"` : '无法回读'
    throw new Error(`「${label}」填充未生效，实际=${got}${why}`)
  }
}
