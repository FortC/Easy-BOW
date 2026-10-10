import {
  BookOpen,
  Camera,
  Check,
  Eraser,
  Eye,
  FileText,
  Pause,
  PenLine,
  Play,
  Sparkles,
  Square,
  Timer,
  Undo2,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentAction, AgentStatus, Settings, StepRecord, TaskTemplate } from '@shared/types'
import { fillTemplateVars, parseTemplateVars, type TplVar } from '../lib/templateVars'

/** 压缩剪贴板截图：最长边 1600px 的 JPEG dataURL（省 token / IPC 体积） */
async function normalizeImage(source: Blob | string): Promise<string | null> {
  try {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source)
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => resolve(null)
      im.src = url
    })
    if (typeof source !== 'string') URL.revokeObjectURL(url)
    if (!img) return null
    const maxSide = 1600
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return null
  }
}

interface HistItem {
  task: string
  ts: number
  result: string
  state: string
  /** 用户反馈：任务是否正确完成（统计正确率用） */
  feedback?: 'good' | 'bad'
  /** 步骤摘要（文本 chips，供历史回看） */
  steps?: { n: number; thought: string; actions: string[] }[]
}

function loadHist(): HistItem[] {
  try {
    return JSON.parse(localStorage.getItem('easybow.history') || '[]').slice(0, 10)
  } catch {
    return []
  }
}

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + '分钟前'
  if (d < 86400000) return Math.floor(d / 3600000) + '小时前'
  return Math.floor(d / 86400000) + '天前'
}

function actionChip(a: AgentAction): { text: string; cls: string } {
  switch (a.name) {
    case 'click':
      return { text: `点击[${a.index}]`, cls: 'chip' }
    case 'type':
      return { text: `输入[${a.index}] "${(a.text || '').slice(0, 18)}"`, cls: 'chip' }
    case 'paste_rich':
      return { text: `📝富文本 "${(a.text || '').slice(0, 16)}"`, cls: 'chip' }
    case 'paste_image':
      return { text: `🖼嵌图 ${(a.url || '').slice(0, 24)}`, cls: 'chip' }
    case 'repeat':
      return { text: `🔁重放×${a.amount ?? 2}`, cls: 'chip' }
    case 'scroll':
      return { text: `滚动 ${a.direction || 'down'}`, cls: 'chip' }
    case 'drag':
      return { text: a.index2 != null ? `拖动[${a.index}]→[${a.index2}]` : `拖动[${a.index}] ${a.direction || 'right'}`, cls: 'chip' }
    case 'goto':
      return { text: `打开 ${(a.url || '').slice(0, 26)}`, cls: 'chip' }
    case 'read_content':
      return { text: '读取页面内容', cls: 'chip' }
    case 'extract_images':
      return { text: '抓取图片资源', cls: 'chip' }
    case 'save':
      return { text: `存记忆「${a.key}」`, cls: 'chip memchip' }
    case 'recall':
      return { text: `取记忆「${a.key}」`, cls: 'chip memchip' }
    case 'switch_tab':
      return { text: `切换到页签${a.index}`, cls: 'chip tabchip' }
    case 'new_tab':
      return { text: `新页签${a.url ? ' ' + a.url.slice(0, 18) : ''}`, cls: 'chip tabchip' }
    case 'close_tab':
      return { text: `关闭页签${a.index}`, cls: 'chip tabchip' }
    case 'done':
      return { text: `✅ 完成: ${(a.result || a.value || '').slice(0, 30)}`, cls: 'chip ok' }
    case 'back':
      return { text: '后退', cls: 'chip' }
    case 'forward':
      return { text: '前进', cls: 'chip' }
    case 'wait':
      return { text: a.seconds ? `等待${a.seconds}s` : '等待人工', cls: 'chip' }
    default:
      return { text: a.name, cls: 'chip' }
  }
}

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  captcha: '需人工验证',
  done: '完成',
  error: '出错',
  stopped: '已停止'
}

export default function TaskPanel(props: {
  status: AgentStatus
  steps: StepRecord[]
  settings: Settings | null
  ocr: { enabled: boolean; reason?: string }
  task: string
  setTask: (t: string) => void
  /** 面板已折叠（只留一条展开按钮） */
  collapsed: boolean
  /** 点击折叠条上的展开按钮 */
  onExpandPanel: () => void
  onExpandEditor: () => void
  onOpenSchedule: () => void
  onOpenKB: () => void
  onToast: (msg: string, kind?: 'info' | 'success' | 'error' | 'captcha') => void
  onShotClick: (dataUrl: string) => void
}) {
  const { status, task, setTask } = props
  const [hist, setHist] = useState<HistItem[]>(loadHist)
  const [expandedTs, setExpandedTs] = useState<number | null>(null)
  const [askDone, setAskDone] = useState<{ task: string; key: string } | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const running = status.state === 'running' || status.state === 'paused' || status.state === 'captcha'
  const paused = status.state === 'paused' || status.state === 'captcha'
  // 人工介入：指导输入 + 待发送截图
  const [guideText, setGuideText] = useState('')
  const [guideImg, setGuideImg] = useState<string | null>(null)
  // 任务模板：chips / 📄 菜单 /「/」快捷选择 / 填空变量表单 / 存为模板
  const [tplList, setTplList] = useState<TaskTemplate[]>([])
  const [tplMenu, setTplMenu] = useState(false)
  const [slash, setSlash] = useState<{ query: string; sel: number } | null>(null)
  const [varFill, setVarFill] = useState<{
    text: string
    vars: TplVar[]
    values: Record<string, string>
    /** 插入位置（「/」快捷触发时替换 /关键词）；缺省=追加到末尾 */
    range?: { start: number; end: number }
    /** start=变量填完后直接开始任务 */
    mode?: 'insert' | 'start'
  } | null>(null)
  const [saveTpl, setSaveTpl] = useState<{ text: string; name: string; group: string; pinned: boolean } | null>(null)
  const taskRef = useRef<HTMLTextAreaElement>(null)
  // ✨ AI 增强：任务描述格式/内容增强（保留原文可一键还原）
  const [enhancing, setEnhancing] = useState(false)
  const [enhancedOrig, setEnhancedOrig] = useState<string | null>(null)
  // 面板 tab：任务（输入/模板/历史）/ 执行（人工介入/状态/节点/时间线）/ 记忆
  const [tab, setTab] = useState<'task' | 'run' | 'mem'>('task')
  // 任务启动/暂停/需人工时自动切到「执行」tab（看进度、做人工介入）
  useEffect(() => {
    if (status.state === 'running' || status.state === 'paused' || status.state === 'captcha') setTab('run')
  }, [status.state])
  const curNode =
    status.plan && status.plan.nodes.length
      ? status.plan.nodes[Math.min(status.plan.current, status.plan.nodes.length) - 1]
      : undefined

  /** 人工批准当前节点通过（跳过其复核并推进；暂停中自动继续） */
  const approveNode = async () => {
    try {
      await window.easybow.approveNode()
      props.onToast('已批准当前节点通过，AI 继续执行', 'success')
    } catch (e: any) {
      props.onToast(e?.message || '批准失败', 'error')
    }
  }

  /** 任务终止/完成后清空显示：时间线、任务记忆、状态一起归零（不影响历史记录） */
  const clearNow = async () => {
    try {
      await window.easybow.clearDisplay()
      props.onToast('已清空执行显示与任务记忆', 'success')
    } catch (e: any) {
      props.onToast(e?.message || '清空失败', 'error')
    }
  }

  useEffect(() => {
    window.easybow
      .getTemplates()
      .then(setTplList)
      .catch(() => {})
  }, [])

  /** 把模板正文落到任务输入框（range 缺省=追加到末尾） */
  const applyTplText = (resolved: string, range?: { start: number; end: number }) => {
    if (range) setTask(task.slice(0, range.start) + resolved + task.slice(range.end))
    else setTask(task.trim() ? task + '\n\n' + resolved : resolved)
  }

  /** 插入模板：有填空变量先弹表单；自动变量（日期/网址等）由主进程解析 */
  const insertTemplate = async (t: TaskTemplate, range?: { start: number; end: number }) => {
    const vars = parseTemplateVars(t.text)
    if (vars.length) {
      setVarFill({ text: t.text, vars, values: {}, range, mode: 'insert' })
      return
    }
    try {
      applyTplText(await window.easybow.resolveTemplateVars(t.text), range)
    } catch {
      applyTplText(t.text, range)
    }
  }

  /** 填空表单确认：变量替换 + 自动变量解析后落地/开跑 */
  const confirmVarFill = async () => {
    if (!varFill) return
    const filled = fillTemplateVars(varFill.text, varFill.values)
    let resolved = filled
    try {
      resolved = await window.easybow.resolveTemplateVars(filled)
    } catch {}
    const mode = varFill.mode
    const range = varFill.range
    setVarFill(null)
    if (mode === 'start') {
      setTask(resolved)
      try {
        await window.easybow.startTask(resolved)
      } catch (e: any) {
        props.onToast(e?.message || '启动失败', 'error')
      }
      return
    }
    applyTplText(resolved, range)
  }

  /** 「/」快捷列表（按 / 后的关键词过滤） */
  const slashList = () => {
    const q = (slash?.query || '').toLowerCase()
    return tplList.filter((t) => !q || t.name.toLowerCase().includes(q) || t.text.toLowerCase().includes(q)).slice(0, 6)
  }

  /** 选中「/」菜单项：把 /关键词 替换为模板内容 */
  const pickSlash = async (t: TaskTemplate) => {
    const el = taskRef.current
    const pos = el?.selectionStart ?? task.length
    const m = /(^|[\s\n])\/([^\s/\n]{0,12})$/.exec(task.slice(0, pos))
    setSlash(null)
    const range = m ? { start: pos - (1 + m[2].length), end: pos } : undefined
    await insertTemplate(t, range)
  }

  /** ✨ AI 增强任务描述（格式 + 内容），原文保留可一键还原 */
  const enhanceTask = async () => {
    if (!task.trim() || enhancing) return
    setEnhancing(true)
    try {
      const orig = task
      const next = await window.easybow.enhanceTask(task.trim())
      setEnhancedOrig(orig)
      setTask(next)
      props.onToast('已增强任务描述，可继续微调（点「↩ 还原」恢复原文）', 'success')
    } catch (e: any) {
      props.onToast(e?.message || '增强失败', 'error')
    } finally {
      setEnhancing(false)
    }
  }

  /** 存为模板确认 */
  const doSaveTpl = async () => {
    if (!saveTpl) return
    try {
      const list = await window.easybow.saveTemplate({
        name: saveTpl.name || '未命名模板',
        group: saveTpl.group,
        text: saveTpl.text,
        pinned: saveTpl.pinned
      })
      setTplList(list)
      setSaveTpl(null)
      props.onToast('已存为任务模板 ✅', 'success')
    } catch (e: any) {
      props.onToast(e?.message || '保存失败', 'error')
    }
  }

  const attachImage = async (blob: Blob | null) => {
    if (!blob) return
    const dataUrl = await normalizeImage(blob)
    if (dataUrl) setGuideImg(dataUrl)
    else props.onToast('截图读取失败（仅支持图片）', 'error')
  }

  /** 从系统剪贴板读图（用户 Win+Shift+S / Cmd+Shift+4 截好图后点这里）。
   *  走主进程 Electron clipboard（新版 W3C API）：渲染进程的 navigator.clipboard.read()
   *  需要 clipboard-read 权限且 Electron 默认不授予，永远失败——这就是旧版按钮不可用的根因 */
  const pickClipboardImage = async () => {
    try {
      const dataUrl = await window.easybow.readClipboardImage()
      if (!dataUrl) {
        props.onToast('剪贴板里没有图片，请先截图（Win+Shift+S）再点', 'info')
        return
      }
      const compressed = await normalizeImage(dataUrl)
      if (compressed) setGuideImg(compressed)
      else props.onToast('截图读取失败（仅支持图片）', 'error')
    } catch {
      props.onToast('无法读取剪贴板（也可在输入框里直接 Ctrl+V 粘贴截图）', 'error')
    }
  }

  const sendGuidance = async () => {
    const text = guideText.trim()
    if (!text && !guideImg) return
    try {
      await window.easybow.sendGuidance(text, guideImg || undefined)
      setGuideText('')
      setGuideImg(null)
    } catch (e: any) {
      props.onToast(e?.message || '发送失败', 'error')
    }
  }

  const saveHist = (list: HistItem[]) => {
    setHist(list)
    localStorage.setItem('easybow.history', JSON.stringify(list.slice(0, 10)))
  }

  // 任务结束时写入历史（含步骤摘要，供历史回看）
  // 依赖补齐 steps：原实现只依赖 status.state，steps 更新后不会重写摘要
  const stepsRef = useRef(props.steps)
  stepsRef.current = props.steps
  useEffect(() => {
    if ((status.state === 'done' || status.state === 'error' || status.state === 'stopped') && status.task) {
      setHist((h) => {
        const steps = stepsRef.current
          .slice(-30)
          .map((s) => ({ n: s.n, thought: (s.thought || '').slice(0, 60), actions: s.actions.map((a) => actionChip(a).text) }))
        const next = [
          { task: status.task, ts: Date.now(), result: status.result || '', state: status.state, steps },
          ...h.filter((x) => x.task !== status.task)
        ].slice(0, 10)
        localStorage.setItem('easybow.history', JSON.stringify(next))
        return next
      })
    }
  }, [status.state, status.task])

  // 任务完成（done）后弹框收集「是否正确完成」反馈（每个任务只问一次）
  useEffect(() => {
    if (status.state !== 'done' || !status.task) return
    const key = status.task + '@' + status.usage.steps
    try {
      if (localStorage.getItem('easybow.fbAsked') === key) return
      localStorage.setItem('easybow.fbAsked', key)
    } catch {}
    setAskDone({ task: status.task, key })
  }, [status.state, status.task])

  const answerFeedback = (fb: 'good' | 'bad') => {
    setAskDone(null)
    setHist((h) => {
      if (!h.length) return h
      const next = [...h]
      next[0] = { ...next[0], feedback: next[0].state === 'done' ? fb : next[0].feedback }
      localStorage.setItem('easybow.history', JSON.stringify(next))
      return next
    })
    props.onToast(fb === 'good' ? '已记录：任务正确完成 ✅' : '已记录：任务未正确完成，供后续优化参考', 'info')
  }

  const goodCount = hist.filter((h) => h.feedback === 'good').length
  const badCount = hist.filter((h) => h.feedback === 'bad').length

  const start = async () => {
    if (!task.trim()) return
    // 任务文本里还有未填的模板变量（{{字段:说明}}）→ 先填空再启动
    const vars = parseTemplateVars(task)
    if (vars.length) {
      setVarFill({ text: task, vars, values: {}, mode: 'start' })
      return
    }
    try {
      await window.easybow.startTask(task.trim())
    } catch (e: any) {
      props.onToast(e?.message || '启动失败', 'error')
    }
  }

  const fmtTok = (n: number) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n))

  return (
    <aside className={`panel${props.collapsed ? ' collapsed' : ''}`}>
      {props.collapsed && (
        <button
          className="panel-collapse-btn"
          title="展开 AI 任务面板（Ctrl+B）"
          aria-label="展开 AI 任务面板"
          onClick={props.onExpandPanel}
        >
          ‹
        </button>
      )}
      <div className="panel-head">
        <div className="panel-title">
          AI 任务
          <span
            className={`ocr-dot ${props.ocr.enabled ? 'on' : ''}`}
            title={props.ocr.enabled ? '本地 OCR 已启用（图片识别免费离线）' : props.ocr.reason || 'OCR 未启用'}
          />
          <span
            className="kb-entry-btn"
            title="问题经验库：记录站点踩坑的处理方式，AI 执行时自动参考"
            onClick={props.onOpenKB}
          >
            <BookOpen size={13} strokeWidth={2} /> 经验库
          </span>
          <span
            className="kb-entry-btn sch-open-btn"
            title="定时任务：把任务描述设为定时（每天/间隔/单次），到点 AI 空闲时自动执行"
            onClick={props.onOpenSchedule}
          >
            <Timer size={13} strokeWidth={2} /> 定时
          </span>
          {!running && (props.steps.length > 0 || Object.keys(status.memory || {}).length > 0) && (
            <span
              className="kb-entry-btn clear-open-btn"
              title="清空时间线与任务记忆，状态回到空闲（任务结束后使用；不影响「最近任务」历史）"
              onClick={clearNow}
            >
              <Eraser size={13} strokeWidth={2} /> 清空
            </span>
          )}
          <span className="panel-model">{props.settings ? props.settings.model || '未配置模型' : '加载中…'}</span>
        </div>
      </div>

      <div className="panel-tabs" role="tablist" aria-label="任务面板功能区">
        <button
          className={`panel-tab-btn${tab === 'task' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'task'}
          onClick={() => setTab('task')}
        >
          <PenLine size={13} strokeWidth={2} /> 任务
        </button>
        <button
          className={`panel-tab-btn${tab === 'run' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'run'}
          onClick={() => setTab('run')}
        >
          <Play size={13} strokeWidth={2} /> 执行
          {running && <span className={`panel-tab-dot ${status.state}`} title={status.statusText} />}
        </button>
        <button
          className={`panel-tab-btn${tab === 'mem' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'mem'}
          onClick={() => setTab('mem')}
        >
          📦 记忆
          {Object.keys(status.memory || {}).length > 0 && (
            <span className="panel-tab-count">{Object.keys(status.memory || {}).length}</span>
          )}
        </button>
      </div>

      {tab === 'task' && (
        <div className="panel-tab tab-task" role="tabpanel">
      <div className="task-box">
        <div className="task-wrap">
          <textarea
            ref={taskRef}
            className="task-input"
            placeholder={'描述任务，例如：\n在页签1搜索“无线鼠标”并读取前3个商品价格存入记忆；切到页签2填进表单\n（输入 / 快速插入模板；复杂任务点 ⤢ 大编辑器）'}
            value={task}
            onChange={(e) => {
              const val = e.target.value
              setTask(val)
              // 「/」快捷触发：光标前是 行首或空白 + /关键词
              const pos = e.target.selectionStart ?? val.length
              const m = /(^|[\s\n])\/([^\s/\n]{0,12})$/.exec(val.slice(0, pos))
              setSlash(m ? { query: m[2], sel: 0 } : null)
            }}
            onKeyDown={(e) => {
              if (!slash) return
              const list = slashList()
              if (e.key === 'Enter' || e.key === 'Tab') {
                if (list.length) {
                  e.preventDefault()
                  pickSlash(list[Math.min(slash.sel, list.length - 1)])
                }
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlash(null)
                return
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = Math.max(list.length, 1)
                setSlash({ ...slash, sel: (slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
              }
            }}
            onBlur={() => setSlash(null)}
            disabled={running}
          />
          <button
            className="expand-btn"
            title="放大编辑（复杂长任务用这个）"
            onClick={props.onExpandEditor}
            disabled={running}
          >
            ⤢ 大编辑器
          </button>
          {slash && slashList().length > 0 && (
            <div className="tpl-slash" role="listbox" aria-label="模板快捷选择">
              {slashList().map((t, i) => (
                <div
                  key={t.id}
                  className={`tpl-slash-item${i === slash.sel ? ' sel' : ''}`}
                  role="option"
                  aria-selected={i === slash.sel}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSlash(t)
                  }}
                  onMouseEnter={() => setSlash({ ...slash, sel: i })}
                >
                  <span className="tpl-slash-name">{t.name}</span>
                  <span className="tpl-slash-text">{t.text.slice(0, 24)}…</span>
                </div>
              ))}
              <div className="tpl-slash-hint">↑↓ 选择 · Enter 插入 · Esc 取消</div>
            </div>
          )}
        </div>
        <div className="task-hint">
          <span className="task-hint-text">
            {task.trim() ? `${task.length} 字` : '小提示：任务越具体（网址、字段名、步骤），AI 执行越准'}
          </span>
          {!running && task.trim() && (
            <button
              className="btn mini enhance-btn"
              title="让 AI 把这段描述增强为清晰、结构化的任务指令（补步骤/字段/预期，保留原意）"
              onClick={enhanceTask}
              disabled={enhancing}
            >
              {enhancing ? (
                <>
                  <Sparkles size={12} strokeWidth={2} /> 增强中…
                </>
              ) : (
                <>
                  <Sparkles size={12} strokeWidth={2} /> AI 增强
                </>
              )}
            </button>
          )}
          {!running && enhancedOrig != null && (
            <button
              className="btn mini"
              title="恢复增强前的原文"
              onClick={() => {
                setTask(enhancedOrig)
                setEnhancedOrig(null)
              }}
            >
              <Undo2 size={12} strokeWidth={2} /> 还原
            </button>
          )}
        </div>
        <div className="tpl-bar">
          {tplList.slice(0, 5).map((t) => (
            <button
              key={t.id}
              className="tpl-chip"
              title={`${t.text.slice(0, 120)}${t.text.length > 120 ? '…' : ''}`}
              disabled={running}
              onClick={() => insertTemplate(t)}
            >
              {t.name}
            </button>
          ))}
          <button
            className="tpl-chip tpl-more"
            title="全部任务模板（插入到任务末尾，可修改）"
            disabled={running}
            onClick={() => setTplMenu(!tplMenu)}
          >
            <FileText size={13} strokeWidth={2} />
          </button>
          {task.trim() && !running && (
            <button
              className="tpl-chip"
              title="把当前任务描述存为模板，下次一键填充"
              onClick={() => setSaveTpl({ text: task, name: task.slice(0, 12), group: '', pinned: true })}
            >
              ＋存模板
            </button>
          )}
        </div>
        {tplMenu && (
          <div className="tpl-menu">
            {tplList.map((t) => (
              <div key={t.id} className="tpl-menu-item">
                <span
                  className="tpl-menu-name"
                  title={t.text.slice(0, 200)}
                  onClick={() => {
                    setTplMenu(false)
                    insertTemplate(t)
                  }}
                >
                  {t.group ? `[${t.group}] ` : ''}
                  {t.name}
                </span>
                <button
                  className="tpl-menu-del"
                  title="删除此模板"
                  onClick={async () => {
                    const list = await window.easybow.deleteTemplate(t.id)
                    setTplList(list)
                  }}
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            ))}
            {!tplList.length && <div className="tpl-menu-empty">暂无模板</div>}
            <div className="tpl-menu-foot">点击插入到任务末尾；模板里的 {'{{字段:说明}}'} 会弹填空表单</div>
          </div>
        )}
        <div className="task-controls">
          {!running ? (
            <button className="btn primary btn-grow" onClick={start} disabled={!task.trim()}>
              <Play size={12} strokeWidth={2.5} /> 开始任务
            </button>
          ) : (
            <>
              {status.state === 'running' ? (
                <button className="btn warn btn-grow" onClick={() => window.easybow.pauseTask()}>
                  <Pause size={12} strokeWidth={2.5} /> 暂停
                </button>
              ) : (
                <button className="btn primary btn-grow" onClick={() => window.easybow.resumeTask()}>
                  <Play size={12} strokeWidth={2.5} /> 继续
                </button>
              )}
              <button className="btn danger" onClick={() => window.easybow.stopTask()}>
                <Square size={12} strokeWidth={2.5} /> 停止
              </button>
            </>
          )}
        </div>
      </div>

      {hist.length > 0 && !running && (
        <div className="hist">
          <h4>
            最近任务
            {goodCount + badCount > 0 && (
              <span className="hist-rate" title={`用户评价：正确 ${goodCount} 次 / 不正确 ${badCount} 次`}>
                正确率 {Math.round((goodCount / (goodCount + badCount)) * 100)}%
              </span>
            )}
          </h4>
          {hist.map((h) => (
            <div key={h.ts} className={`hist-item-wrap${expandedTs === h.ts ? ' open' : ''}`}>
              <div
                className="hist-item"
                role="button"
                tabIndex={0}
                aria-expanded={expandedTs === h.ts}
                onClick={() => setExpandedTs(expandedTs === h.ts ? null : h.ts)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setExpandedTs(expandedTs === h.ts ? null : h.ts)
                  }
                }}
                title={h.result || h.task}
              >
                <span className="h-state">{h.state === 'done' ? '✅' : h.state === 'error' ? '❌' : '⏹'}</span>
                <span className="h-text">{h.task}</span>
                <span className="h-time">{relTime(h.ts)}</span>
                {h.feedback && <span className={`h-fb ${h.feedback}`}>{h.feedback === 'good' ? '👍' : '👎'}</span>}
              </div>
              {expandedTs === h.ts && (
                <div className="hist-detail">
                  {h.result && <div className="hist-result">{h.result}</div>}
                  {!!h.steps?.length && (
                    <div className="hist-steps">
                      {h.steps.map((s) => (
                        <div key={s.n} className="hist-step">
                          <span className="hist-step-n">{s.n}</span>
                          <span className="hist-step-a">{s.actions.join('、') || s.thought}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="hist-ops">
                    <button className="btn mini" onClick={() => { setTask(h.task); setExpandedTs(null) }}>
                      ↺ 复用此任务
                    </button>
                    <button
                      className="btn mini"
                      title="把这条任务描述存为模板（下次一键填充）"
                      onClick={() => {
                        setSaveTpl({ text: h.task, name: h.task.slice(0, 12), group: '', pinned: true })
                        setExpandedTs(null)
                      }}
                    >
                      ⭐ 存为模板
                    </button>
                    {h.state === 'done' && !h.feedback && (
                      <>
                        <button className="btn mini good" onClick={() => { saveHist(hist.map((x) => (x.ts === h.ts ? { ...x, feedback: 'good' as const } : x))) }}>
                          👍 完成
                        </button>
                        <button className="btn mini bad" onClick={() => { saveHist(hist.map((x) => (x.ts === h.ts ? { ...x, feedback: 'bad' as const } : x))) }}>
                          👎 不对
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      </div>
      )}

      {tab === 'run' && (
        <div className="panel-tab tab-run" role="tabpanel">

      {running && (
        <div className={`guide-box${paused ? ' paused' : ''}`}>
          <div className="guide-title">
            🧑 人工介入
            {paused ? (
              <span className="guide-tip">
                你可以直接在浏览器里操作，或在下方给 AI 留言/截图指路，然后点「继续」
              </span>
            ) : (
              <span className="guide-tip">运行中插话：下一步就会带给 AI（也可先暂停再说）</span>
            )}
          </div>
          {paused && curNode?.reason && (
            <div className="guide-reason" title="复核判定的依据，可据此给 AI 留言指路或直接批准本节点通过">
              上次复核未通过：{curNode.reason}
            </div>
          )}
          <textarea
            className="guide-input"
            placeholder={
              paused
                ? '例如：先点击页面中央的正文区域进入编辑状态，出现光标后再输入内容（可配截图圈出位置）'
                : '给 AI 的补充指示，下一步生效…'
            }
            value={guideText}
            rows={2}
            onChange={(e) => setGuideText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                sendGuidance()
              }
            }}
            onPaste={(e) => {
              const file = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))?.getAsFile()
              if (file) {
                e.preventDefault()
                attachImage(file)
              }
            }}
          />
          {guideImg && (
            <div className="guide-img-wrap">
              <img className="guide-img" src={guideImg} alt="待发送的指路截图" />
              <button className="guide-img-del" title="移除截图" onClick={() => setGuideImg(null)}>
                <X size={11} strokeWidth={2.5} />
              </button>
            </div>
          )}
          <div className="guide-ops">
            <button className="btn mini" onClick={pickClipboardImage}>
              <Camera size={12} strokeWidth={2} /> 附截图（剪贴板）
            </button>
            <button className="btn mini primary" onClick={sendGuidance} disabled={!guideText.trim() && !guideImg}>
              发送给 AI
            </button>
            {status.plan && status.plan.current <= status.plan.nodes.length && (
              <button
                className="btn mini good"
                title={`批准节点${status.plan.current}「${curNode?.intent}」通过：跳过其复核、视为预期已达成并继续${paused ? '（将自动继续执行）' : ''}`}
                onClick={approveNode}
              >
                <Check size={12} strokeWidth={2.5} /> 批准本节点通过
              </button>
            )}
            {!!status.pendingGuidance && (
              <span className="guide-queued" title="已排队、将在下一步注入给模型">
                已排队 {status.pendingGuidance} 条
              </span>
            )}
          </div>
        </div>
      )}

      <div className="status-line" role="status" aria-live="polite">
        <span className={`status-badge ${status.state}`}>{STATE_LABEL[status.state] || status.state}</span>
        <span className="status-text" title={status.statusText}>
          {status.state === 'captcha' ? '检测到验证码，请人工完成后点击「继续」' : status.statusText}
        </span>
      </div>

      {status.plan && status.plan.nodes.length > 0 && (
        <div className="node-strip" title="任务节点链：每完成一个节点复核一次预期，未通过自动重试（视觉优先）">
          <span className="node-strip-label">
            节点 {status.plan.current}/{status.plan.nodes.length}
          </span>
          {status.plan.nodes.map((nd, i) => (
            <span
              key={i}
              className={`node-dot ${nd.status}`}
              title={`节点${i + 1}「${nd.intent}」\n预期: ${nd.expected}\n状态: ${
                { pending: '待执行', active: '进行中', passed: '复核通过', failed: '复核未通过·自愈重试中', escalated: '多次未通过·待人工介入' }[nd.status]
              }`}
            >
              {nd.status === 'passed' ? <Check size={10} strokeWidth={3} /> : i + 1}
            </span>
          ))}
          <span className="node-strip-intent">{status.plan.nodes[status.plan.current - 1]?.intent}</span>
          {curNode?.reason && (curNode.status === 'failed' || curNode.status === 'escalated') && (
            <div className="node-reason">
              未通过原因：{curNode.reason}
              {curNode.fails ? `（自愈重试 ${curNode.fails}/3）` : ''}
            </div>
          )}
        </div>
      )}

      <div className="timeline" ref={timelineRef}>
        {props.steps.length === 0 && (
          <div className="timeline-empty">
            操作过程将实时显示在这里
            <span className="timeline-empty-sub">模型只看精简元素列表，每步约 1~4k tokens</span>
          </div>
        )}
        {props.steps
          .slice()
          .reverse()
          .map((s) =>
            s.userGuidance ? (
              <div key={s.n + '-' + s.ts} className="guide-bubble">
                <div className="guide-bubble-head">🧑 你的指导{paused ? '（点「继续」后生效）' : '（将优先执行）'}</div>
                {s.thought && <div className="guide-bubble-text">{s.thought}</div>}
                {s.screenshot && <img className="shot" src={s.screenshot} alt="指路截图" onClick={() => props.onShotClick(s.screenshot!)} />}
              </div>
            ) : (
              <div key={s.n + '-' + s.ts} className={`step-card ${s.actions.some((a) => a.name === 'wait' && a.result?.includes('人工')) ? 'captcha' : ''}`}>
                <div className="step-head">
                  <span className="step-n">{s.n}</span>
                  {s.nodeIdx && (
                    <span className="step-node" title={`属于节点链第 ${s.nodeIdx} 个节点`}>
                      N{s.nodeIdx}
                    </span>
                  )}
                  <span className="step-tab" title={s.url}>
                    {s.tabTitle.slice(0, 16) || '页面'}
                  </span>
                  {s.vision && (
                    <span className="step-vision" title="本步模型收到了页面视口截图（视觉模式）">
                      <Eye size={11} strokeWidth={2} />
                    </span>
                  )}
                  {s.local && (
                    <span className="step-vision step-local" title="本步由本地快速决策模型直出，未走云端（混合模式加速）">
                      <Zap size={11} strokeWidth={2} />
                    </span>
                  )}
                  {s.tokens && (
                    <span className="step-tokens">
                      ↑{fmtTok(s.tokens.input)} ↓{fmtTok(s.tokens.output)} tok
                    </span>
                  )}
                </div>
                {s.thought && <div className="step-thought">{s.thought}</div>}
                <div className="action-chips">
                  {s.actions.map((a, i) => {
                    const { text, cls } = actionChip(a)
                    return (
                      <span key={i} className={a.error ? 'chip err' : cls} title={a.error || a.result || text}>
                        {a.error ? `⚠ ${text}: ${a.error.slice(0, 30)}` : text}
                      </span>
                    )
                  })}
                </div>
                {s.actions
                  .filter((a) => (a.name === 'read_content' || a.name === 'recall') && a.result && !a.error)
                  .map((a, i) => (
                    <details className="read-result" key={'r' + i}>
                      <summary>查看读取的{a.name === 'recall' ? '记忆' : '页面'}内容</summary>
                      <pre>{a.result}</pre>
                    </details>
                  ))}
                {s.screenshot && (
                  <div className="shot-wrap" onClick={() => props.onShotClick(s.screenshot!)} title="点击查看大图">
                    <img className="shot" src={s.screenshot} alt="步骤截图" />
                    {/* T3 命中标记：点击坐标+目标 rect 叠加（归一化 0~1），定位诊断主手段 */}
                    {s.hits?.map((h, i) => (
                      <span
                        key={'h' + i}
                        className="hit-marker"
                        title={h.label ? `命中: ${h.label}` : '点击命中位置'}
                        style={{
                          left: `${h.x * 100}%`,
                          top: `${h.y * 100}%`,
                          width: h.w > 0 ? `${h.w * 100}%` : undefined,
                          height: h.h > 0 ? `${h.h * 100}%` : undefined
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          )}
      </div>

      <div className="usage-bar">
        <span>
          输入 <b>{fmtTok(status.usage.inputTokens)}</b>
        </span>
        <span>
          输出 <b>{fmtTok(status.usage.outputTokens)}</b>
        </span>
        <span>
          合计 <b>{fmtTok(status.usage.inputTokens + status.usage.outputTokens)}</b> tokens
        </span>
        <span>
          步数 <b>{status.stepCount}</b>
        </span>
      </div>

      </div>
      )}

      {tab === 'mem' && (
        <div className="panel-tab tab-mem" role="tabpanel">
          {Object.keys(status.memory || {}).length > 0 ? (
            <div className="mem-section">
              <h4>任务记忆（跨页签保持）</h4>
              {Object.entries(status.memory || {}).map(([k, v]) => {
                const u = v.trim()
                const isImg = /^https?:\/\/\S+\.(jpe?g|png|webp|gif|bmp)([?#]\S*)?$/i.test(u)
                return (
                  <div className="mem-row" key={k}>
                    <div className="mem-row-head">
                      <span className="mem-key" title={k}>
                        {k}
                      </span>
                      {v.length > 60 && (
                        <span className="mem-len" title={`共 ${v.length} 字`}>
                          {v.length}字
                        </span>
                      )}
                      <button
                        className="mem-copy"
                        title="复制内容"
                        onClick={() => {
                          navigator.clipboard
                            .writeText(v)
                            .then(() => props.onToast('已复制', 'success'))
                            .catch(() => props.onToast('复制失败', 'error'))
                        }}
                      >
                        ⧉ 复制
                      </button>
                    </div>
                    {isImg && (
                      <img
                        className="mem-thumb"
                        src={u}
                        alt={k}
                        loading="lazy"
                        title="点击查看大图"
                        onClick={() => props.onShotClick(u)}
                      />
                    )}
                    <div className="mem-val" title={v}>
                      {v}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="mem-empty">任务执行中 save 的数据会存到这里（跨页签保持，文本里可用 {'{{记忆键}}'} 引用）</div>
          )}
        </div>
      )}

      {askDone && (
        <div className="fb-mask" onClick={() => setAskDone(null)}>
          <div
            className="fb-card"
            role="dialog"
            aria-modal="true"
            aria-label="任务完成反馈"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAskDone(null)
            }}
          >
            <div className="fb-title">🎉 AI 报告任务完成</div>
            <div className="fb-task" title={askDone.task}>
              {askDone.task.slice(0, 80)}
            </div>
            <div className="fb-q">实际结果正确吗？（用于统计任务正确率）</div>
            <div className="fb-ops">
              <button className="btn mini good" onClick={() => answerFeedback('good')}>
                👍 正确完成
              </button>
              <button className="btn mini bad" onClick={() => answerFeedback('bad')}>
                👎 没做对
              </button>
              <button className="btn mini" onClick={() => setAskDone(null)}>
                跳过
              </button>
            </div>
          </div>
        </div>
      )}
      {varFill && (
        <div className="fb-mask" onClick={() => setVarFill(null)}>
          <div
            className="fb-card"
            role="dialog"
            aria-modal="true"
            aria-label="填写模板变量"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fb-title">📝 填写模板变量</div>
            <div className="tpl-var-form">
              {varFill.vars.map((v) => (
                <label key={v.name} className="tpl-var-row">
                  <span className="tpl-var-name" title={v.desc}>
                    {v.name}
                  </span>
                  <input
                    placeholder={v.desc}
                    value={varFill.values[v.name] || ''}
                    onChange={(e) => setVarFill({ ...varFill, values: { ...varFill.values, [v.name]: e.target.value } })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        confirmVarFill()
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="fb-ops">
              <button className="btn mini primary" onClick={confirmVarFill}>
                {varFill.mode === 'start' ? '填好并开始任务' : '填好并插入'}
              </button>
              <button className="btn mini" onClick={() => setVarFill(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {saveTpl && (
        <div className="fb-mask" onClick={() => setSaveTpl(null)}>
          <div
            className="fb-card"
            role="dialog"
            aria-modal="true"
            aria-label="存为任务模板"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fb-title">⭐ 存为任务模板</div>
            <div className="tpl-var-form">
              <label className="tpl-var-row">
                <span className="tpl-var-name">模板名</span>
                <input
                  value={saveTpl.name}
                  onChange={(e) => setSaveTpl({ ...saveTpl, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      doSaveTpl()
                    }
                  }}
                />
              </label>
              <label className="tpl-var-row">
                <span className="tpl-var-name">分组</span>
                <input
                  placeholder="如：常用 / 定时任务（可空）"
                  value={saveTpl.group}
                  onChange={(e) => setSaveTpl({ ...saveTpl, group: e.target.value })}
                />
              </label>
              <label className="tpl-var-check">
                <input
                  type="checkbox"
                  checked={saveTpl.pinned}
                  onChange={(e) => setSaveTpl({ ...saveTpl, pinned: e.target.checked })}
                />
                在输入框上方显示为快捷 chip
              </label>
            </div>
            <div className="fb-ops">
              <button className="btn mini primary" onClick={doSaveTpl}>
                保存模板
              </button>
              <button className="btn mini" onClick={() => setSaveTpl(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
