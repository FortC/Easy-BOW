import { useEffect, useRef, useState } from 'react'
import type { AgentAction, AgentStatus, Settings, StepRecord } from '@shared/types'

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
  onOpenSettings: () => void
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
            📚
          </span>
          <span className="panel-model">{props.settings ? props.settings.model || '未配置模型' : '加载中…'}</span>
        </div>
      </div>

      <div className="task-box">
        <div className="task-wrap">
          <textarea
            className="task-input"
            placeholder={'描述任务，例如：\n在页签1搜索“无线鼠标”并读取前3个商品价格存入记忆；切到页签2填进表单\n（复杂任务点右上角 ⤢ 用大编辑器写）'}
            value={task}
            onChange={(e) => setTask(e.target.value)}
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
        </div>
        <div className="task-hint">
          {task.trim() ? `${task.length} 字` : '小提示：任务越具体（网址、字段名、步骤），AI 执行越准'}
        </div>
        <div className="task-controls">
          {!running ? (
            <>
              <button className="btn primary btn-grow" onClick={start} disabled={!task.trim()}>
                ▶ 开始任务
              </button>
              <button
                className="btn"
                title="把当前任务描述设为定时任务（每天/间隔/单次），到点 AI 自动执行"
                onClick={props.onOpenSchedule}
              >
                ⏰ 定时
              </button>
            </>
          ) : (
            <>
              {status.state === 'running' ? (
                <button className="btn warn btn-grow" onClick={() => window.easybow.pauseTask()}>
                  ⏸ 暂停
                </button>
              ) : (
                <button className="btn primary btn-grow" onClick={() => window.easybow.resumeTask()}>
                  ▶ 继续
                </button>
              )}
              <button className="btn danger" onClick={() => window.easybow.stopTask()}>
                ⏹ 停止
              </button>
            </>
          )}
          {!props.settings?.apiKey && (
            <button className="btn" onClick={props.onOpenSettings}>
              ⚙ 配置接口
            </button>
          )}
        </div>
      </div>

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
                ✕
              </button>
            </div>
          )}
          <div className="guide-ops">
            <button className="btn mini" onClick={pickClipboardImage}>
              📷 附截图（剪贴板）
            </button>
            <button className="btn mini primary" onClick={sendGuidance} disabled={!guideText.trim() && !guideImg}>
              发送给 AI
            </button>
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

      {Object.keys(status.memory || {}).length > 0 && (
        <div className="mem-section">
          <h4>任务记忆（跨页签保持）</h4>
          {Object.entries(status.memory || {}).map(([k, v]) => (
            <div className="mem-row" key={k} title={`${k} = ${v}`}>
              <span className="mem-key">{k}</span>
              <span className="mem-val">{v}</span>
            </div>
          ))}
        </div>
      )}

      <div className="timeline" ref={timelineRef}>
        {props.steps.length === 0 && (
          <div className="timeline-empty">
            操作过程将实时显示在这里
            <span className="timeline-empty-sub">模型只看精简元素列表，每步约 1~4k tokens</span>
            <div className="timeline-empty-cta">
              <button className="btn mini" onClick={props.onExpandEditor}>
                ⤢ 用大编辑器写复杂任务
              </button>
            </div>
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
                  <span className="step-tab" title={s.url}>
                    {s.tabTitle.slice(0, 16) || '页面'}
                  </span>
                  {s.vision && (
                    <span className="step-vision" title="本步模型收到了页面视口截图（视觉模式）">
                      👁
                    </span>
                  )}
                  {s.local && (
                    <span className="step-vision step-local" title="本步由本地快速决策模型直出，未走云端（混合模式加速）">
                      ⚡
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
                {s.screenshot && <img className="shot" src={s.screenshot} alt="步骤截图" onClick={() => props.onShotClick(s.screenshot!)} />}
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
    </aside>
  )
}
