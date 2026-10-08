import type { TabManager, Tab } from './tabs'
import type { Overlay } from './overlay'
import { clipboard, nativeImage, ClipboardItem, dialog } from 'electron'
import type { WebContents } from 'electron'
import {
  EXTRACT_FN,
  RESOLVE_FN,
  READ_CONTENT_FN,
  EXTRACT_IMAGES_FN,
  type ExtractResult,
  formatCandidates
} from './extractor'
import { mdToHtml, mdToPlain } from './markdown'
import { EXPECT_TEXT_FN, EXPECT_SEL_FN } from './testcase/assertions'
import { FORM_FIELDS_FN, FORM_SET_FN, type FormField } from './testcase/fields'
import type { AgentAction, Settings } from '@shared/types'

export interface ExecContext {
  memory: Record<string, string>
  signal: AbortSignal
  settings: Settings
  /** 上一步执行成功的动作骨架（repeat 重放用；可缺省） */
  prevActions?: AgentAction[]
  /** 测试模式：生产保护环境下为 true，提交类点击前需人工确认（普通任务恒缺省） */
  protectedSubmit?: boolean
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
}

/** 安全设置 input/textarea 的值（走原生 setter，React 受控组件可感知） */
const SET_VALUE_FN = String(function setValue(framePaths: number[][], path: number[], value: string) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: Element = doc.documentElement
    for (const i of p) {
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el
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
    let el: Element = doc.documentElement
    for (const i of p) {
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el
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

const SCROLL_FN = String(function scrollTo(where: string) {
  if (where === 'top') window.scrollTo({ top: 0 })
  else if (where === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight })
})

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

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
  /** 可选：fill_form 智能填充规划器（LLM 字段映射；index.ts 注入 provider，自测可替换为桩） */
  formFillPlanner?: (
    fields: FormField[],
    ctx: { vars: Record<string, string>; constraints: string; onlyRequired: boolean }
  ) => Promise<import('./testcase/fields').FormFillItem[]>

  constructor(tabManager: TabManager) {
    this.tabManager = tabManager
  }

  async extract(tab?: Tab): Promise<ExtractResult> {
    const t = tab || this.tabManager.active()
    if (!t) throw new Error('没有可用页签')
    const res = await t.cdp.evaluate<ExtractResult>(EXTRACT_FN, [this.snapshotLimit()])
    if (!res || !Array.isArray(res.candidates)) {
      throw new Error('页面提取结果为空（页面可能还在加载或为特殊页面）')
    }
    this.snapshots.set(t.id, res)
    return res
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

  formatForPrompt(res: ExtractResult, limit: number, withCoords = false): string {
    const sliced: ExtractResult = { ...res, candidates: res.candidates.slice(0, limit) }
    return formatCandidates(sliced, withCoords)
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

  private async resolveIndex(t: Tab, index: number): Promise<Resolved> {
    const snap = this.snapshots.get(t.id)
    if (!snap || index < 0 || index >= snap.candidates.length) return { found: false }
    const cand = snap.candidates[index]
    const r = await t.cdp.evaluate<Resolved>(RESOLVE_FN, [cand.framePaths, cand.path, cand.tag])
    if (!r.found) {
      // DOM 变动（SPA 重渲染/虚拟滚动/懒加载占位）：重新提取一次，
      // 优先按 标签+文本 重定位（重渲染后序号会漂移，直接复用 index 不可靠）
      const fresh = await this.extract(t)
      const c2 =
        (cand.text
          ? fresh.candidates.find((c) => c.tag === cand.tag && c.text === cand.text)
          : undefined) ?? fresh.candidates[index]
      if (!c2) return { found: false }
      return t.cdp.evaluate<Resolved>(RESOLVE_FN, [c2.framePaths, c2.path, c2.tag])
    }
    return r
  }

  /** 等待页面加载 settle（导航后的稳定窗口） */
  private async waitSettle(t: Tab, signal: AbortSignal, slow: boolean): Promise<void> {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && !signal.aborted) {
      try {
        if (!t.view.webContents.isLoading()) break
      } catch {
        break
      }
      await this.sleep(200, signal)
    }
    await this.sleep(slow ? 1200 : 600, signal)
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
        ['click', 'type', 'scroll', 'drag', 'paste_rich', 'paste_image'].includes(a.name)
      )
    try {
      if (needsOverlay && this.overlay && !ctx.signal.aborted) await this.overlay.begin()
      for (let i = 0; i < actions.length && i < 5; i++) {
        if (ctx.signal.aborted) break
        const a = { ...actions[i] }
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
          out.push(a)
          break // 出错即停止本批，下一步让模型看到错误并自行调整
        }
        if (i < actions.length - 1) await this.humanDelay(ctx.settings, ctx.signal)
      }
      // 批后等页面稳定
      const t = this.tabManager.active()
      if (t && !ctx.signal.aborted) await this.waitSettle(t, ctx.signal, ctx.settings.speed === 'slow')
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
        if (!r.found) throw new Error(`元素[${a.index}]已失效（页面可能已变化）`)
        if (r.w === 0 || r.h === 0) throw new Error(`元素[${a.index}]不可见`)
        // 测试模式生产保护：提交/删除类点击需人工确认（普通任务 protectedSubmit 恒缺省，零影响）
        if (ctx.protectedSubmit) {
          const snap = this.snapshots.get(t.id)
          const cand = snap?.candidates[a.index]
          const label = `${cand?.text || ''} ${cand?.extra || ''}`.trim()
          if (/提交|确定|保存|下单|支付|发布|删除|结算/.test(label)) {
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
        }
        await this.sleep(160, ctx.signal)
        if (this.overlay) {
          try {
            await this.overlay.moveTo(r.x!, r.y!)
          } catch {}
        }
        await t.cdp.mouseClick(r.x! + rand(-2, 2), r.y! + rand(-2, 2))
        if (this.overlay) {
          try {
            await this.overlay.click(r.x!, r.y!)
          } catch {}
        }
        a.result = `点击(${Math.round(r.x!)},${Math.round(r.y!)})`
        return false
      }
      case 'type': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        if (a.index == null || a.text == null) throw new Error('type 需要 index 和 text')
        let text = a.text
        // {{记忆键}} 引用替换
        text = text.replace(/\{\{([^}]+)\}\}/g, (_m, k) => ctx.memory[String(k).trim()] ?? '')
        await this.focusTarget(t, a.index, ctx)
        const [framePaths, path] = await this.pathsFor(t, a.index)

        // 1) 真实键入：Ctrl+A 全选后走输入法通道替换（trusted 输入管线，框架渲染的站点最买账）
        await t.cdp.keySelectAll()
        await this.sleep(60, ctx.signal)
        await t.cdp.insertText(text)
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
        // 下载：http(s) 先走页签会话（带登录态 Cookie），失败或 data:/blob: 走全局 fetch
        const buf = await this.downloadImage(url, wc, ctx)
        const nat = nativeImage.createFromBuffer(buf)
        if (nat.isEmpty()) throw new Error('图片解码失败（可能为 SVG 或不支持的格式），换一个图片链接试试')
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
        } else {
          const amount = Math.min(Math.max(a.amount || 3, 1), 10)
          const vh = 500
          const dy = (dir === 'down' ? 1 : -1) * amount * 350
          // 分几次小滚轮，更像真人
          for (let k = 0; k < amount; k++) {
            if (ctx.signal.aborted) break
            await t.cdp.mouseWheel(400, vh, 0, (dy / amount) | 0)
            await this.sleep(120, ctx.signal)
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
        return false
      }
      case 'extract_images': {
        const t = tm.active()
        if (!t) throw new Error('没有可用页签')
        // 抓取页面图片资源链接（主图/详情图：img+srcset+懒加载属性+CSS背景图，按尺寸排序）
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
  private async focusTarget(t: Tab, index: number, ctx: ExecContext): Promise<void> {
    const r = await this.resolveIndex(t, index)
    if (!r.found) throw new Error(`元素[${index}]已失效（页面可能已变化）`)
    await this.sleep(160, ctx.signal)
    if (this.overlay) {
      try {
        await this.overlay.moveTo(r.x!, r.y!)
      } catch {}
    }
    // 先点击聚焦（trusted mousedown 对站点脚本可见）
    await t.cdp.mouseClick(r.x! + rand(-2, 2), r.y! + rand(-2, 2))
    if (this.overlay) {
      try {
        await this.overlay.click(r.x!, r.y!)
      } catch {}
    }
    await this.sleep(220, ctx.signal)
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
      if (/^https?:/i.test(url)) {
        try {
          const r = await wc.session.fetch(url, { signal: ctl.signal } as any)
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer())
            if (buf.length) return buf
          }
        } catch {}
      }
      const r = await fetch(url, { signal: ctl.signal } as any)
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) throw new Error('图片内容为空')
      return buf
    } finally {
      cleanup()
    }
  }

  /** type 动作用：按快照取元素的 framePaths/path */
  private async pathsFor(t: Tab, index: number): Promise<[number[][], number[]]> {    const snap = this.snapshots.get(t.id)
    if (!snap || index < 0 || index >= snap.candidates.length) throw new Error(`元素[${index}]不存在`)
    const c = snap.candidates[index]
    return [c.framePaths, c.path]
  }

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
    await t.cdp.mouseClick(r.x + rand(-2, 2), r.y + rand(-2, 2))
    await this.sleep(200, ctx.signal)
    await t.cdp.keySelectAll()
    await this.sleep(60, ctx.signal)
    await t.cdp.insertText(value)
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
