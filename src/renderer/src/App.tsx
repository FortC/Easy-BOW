import { Globe, Settings as SettingsIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatus, Bookmark, MainEvent, Settings, StepRecord, TabInfo } from '@shared/types'
import TabBar from './components/TabBar'
import Toolbar from './components/Toolbar'
import TaskPanel from './components/TaskPanel'
import SettingsModal from './components/SettingsModal'
import TaskEditorModal from './components/TaskEditorModal'
import BookmarksBar from './components/BookmarksBar'
import KnowledgeModal from './components/KnowledgeModal'
import HistoryDropdown from './components/HistoryDropdown'
import ScheduleModal from './components/ScheduleModal'
import TestPanel from './components/TestPanel'
import { useDelayedUnmount } from './hooks/useDelayedUnmount'

interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error' | 'captcha'
  /** 处于退场阶段（播完动画再真正移除） */
  closing?: boolean
}

const IDLE_STATUS: AgentStatus = {
  state: 'idle',
  task: '',
  stepCount: 0,
  statusText: '空闲',
  usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
  memory: {}
}

/** 定时任务倒计时条高度，与 styles.css 的 --countdown-h 保持一致 */
const COUNTDOWN_H = 33
/** 退场时长，与 styles.css 中 .is-closing 动画时长一致 */
const UNMOUNT_MS = 160

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState(-1)
  const [status, setStatus] = useState<AgentStatus>(IDLE_STATUS)
  const [steps, setSteps] = useState<StepRecord[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [taskEditorOpen, setTaskEditorOpen] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /** 定时任务弹窗预绑定的测试用例（用例库⏰ 按钮进来） */
  const [scheduleTestCase, setScheduleTestCase] = useState<{ id: number; name: string } | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  /** 测试面板收起为右侧悬浮按钮（执行期间让出画面，点击可随时展开） */
  const [testCollapsed, setTestCollapsed] = useState(false)
  const [task, setTask] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ocr, setOcr] = useState<{ enabled: boolean; reason?: string }>({ enabled: false })
  const [viewer, setViewer] = useState<string | null>(null)
  /** 即将执行的定时任务倒计时（执行前 60s 内出现） */
  const [countdown, setCountdown] = useState<{ id: number; name: string; secondsLeft: number } | null>(null)
  /** 右侧面板折叠态 */
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  const addrRef = useRef<HTMLInputElement>(null)
  const toastId = useRef(1)

  /** 统一的 Toast 移除：先播退场动画再真正移除 */
  const dropToast = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, closing: true } : x)))
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), UNMOUNT_MS)
  }, [])

  const pushToast = useCallback(
    (message: string, kind: Toast['kind'] = 'info') => {
      const id = toastId.current++
      setToasts((t) => [...t, { id, message, kind }])
      window.setTimeout(() => dropToast(id), kind === 'captcha' ? 12000 : 5000)
    },
    [dropToast]
  )

  // 收藏栏（localStorage 持久化）
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('easybow.bookmarks') || '[]')
    } catch {
      return []
    }
  })
  const saveBookmarks = useCallback((list: Bookmark[]) => {
    setBookmarks(list)
    localStorage.setItem('easybow.bookmarks', JSON.stringify(list))
  }, [])
  const toggleFav = useCallback(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    if (!t?.url) return
    const exists = bookmarks.some((b) => b.url === t.url)
    if (exists) {
      saveBookmarks(bookmarks.filter((b) => b.url !== t.url))
      pushToast('已从收藏栏移除', 'info')
    } else {
      saveBookmarks([{ title: (t.title || t.url).slice(0, 20), url: t.url, ts: Date.now() }, ...bookmarks])
      pushToast('已收藏，可在收藏栏一键打开', 'success')
    }
  }, [tabs, activeTabId, bookmarks, saveBookmarks, pushToast])

  // 订阅主进程事件
  useEffect(() => {
    const off = window.easybow.onEvent((ev: MainEvent) => {
      switch (ev.channel) {
        case 'tabs':
          setTabs(ev.tabs)
          setActiveTabId(ev.activeTabId)
          break
        case 'agent-status':
          setStatus(ev.status)
          break
        case 'step':
          setSteps((s) => [...s, ev.step].slice(-60))
          break
        case 'steps-clear':
          setSteps([])
          break
        case 'toast':
          pushToast(ev.message, ev.kind)
          break
        case 'ocr-status':
          setOcr({ enabled: ev.enabled, reason: ev.reason })
          break
        case 'schedule-countdown':
          setCountdown(ev.secondsLeft > 0 ? { id: ev.id, name: ev.name, secondsLeft: ev.secondsLeft } : null)
          break
        default:
          break
      }
    })
    window.easybow.getAgentStatus().then(setStatus)
    window.easybow.getSettings().then(setSettings)
    return off
  }, [pushToast])

  // 新任务开始时清空时间线（依赖 state + stepCount，而非只看 task）
  useEffect(() => {
    if (status.state === 'running' && status.stepCount === 0) setSteps([])
  }, [status.state, status.stepCount])

  // 浏览器区域位置上报（主进程据此摆放 WebContentsView）
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      window.easybow.setBrowserRect({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  // 倒计时停止推送（已执行/已取消）后自动隐藏倒计时条
  useEffect(() => {
    if (!countdown) return
    const t = window.setTimeout(() => setCountdown(null), 2500)
    return () => window.clearTimeout(t)
  }, [countdown])

  // 是否有弹窗/浮层正在覆盖浏览器视图（原生视图会盖住渲染层，必须主动隐藏）
  // —— 单一来源：隐藏原生视图与占位提示共用它，避免两处表达式失同步
  const overlayOpen = useMemo(
    () =>
      settingsOpen ||
      viewer != null ||
      taskEditorOpen ||
      kbOpen ||
      historyOpen ||
      scheduleOpen ||
      (testOpen && !testCollapsed),
    [settingsOpen, viewer, taskEditorOpen, kbOpen, historyOpen, scheduleOpen, testOpen, testCollapsed]
  )
  useEffect(() => {
    window.easybow.setBrowserHidden(overlayOpen)
  }, [overlayOpen])

  // 全局快捷键：Ctrl/Cmd+T 新建页签、Ctrl+W 关闭当前页、Ctrl+L 聚焦地址栏、
  // Ctrl+B 折叠/展开任务面板、F5 刷新。Esc 交给各弹窗自行处理。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 't') {
        e.preventDefault()
        window.easybow.newTab()
      } else if (mod && k === 'w') {
        e.preventDefault()
        if (activeTabId >= 0) window.easybow.closeTab(activeTabId)
      } else if (mod && k === 'l') {
        e.preventDefault()
        addrRef.current?.focus()
      } else if (mod && k === 'b') {
        e.preventDefault()
        setPanelCollapsed((v) => !v)
      } else if (e.key === 'F5') {
        e.preventDefault()
        window.easybow.reload()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId])

  // 退场动画：先播动画再卸载（常驻挂载的弹窗不需要）
  const [taskEditorMounted] = useDelayedUnmount(taskEditorOpen, UNMOUNT_MS)
  const [kbMounted] = useDelayedUnmount(kbOpen, UNMOUNT_MS)
  const [scheduleMounted] = useDelayedUnmount(scheduleOpen, UNMOUNT_MS)
  const [viewerMounted] = useDelayedUnmount(viewer != null, UNMOUNT_MS)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="app">
      {countdown && (
        <div className="sched-countdown-bar" role="status">
          <span className="scd-icon">⏰</span>
          <span className="scd-text">
            定时任务「<b>{countdown.name}</b>」将在 <b className="scd-secs">{countdown.secondsLeft}</b> 秒后执行
          </span>
          <button
            className="btn mini danger"
            onClick={async () => {
              await window.easybow.cancelScheduledRun(countdown.id)
              setCountdown(null)
            }}
          >
            取消本次
          </button>
        </div>
      )}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={(id) => window.easybow.switchTab(id)}
        onClose={(id) => window.easybow.closeTab(id)}
        onNew={() => window.easybow.newTab()}
      />
      <Toolbar
        activeTab={activeTab}
        agentState={status.state}
        isFav={!!activeTab?.url && bookmarks.some((b) => b.url === activeTab.url)}
        onToggleFav={toggleFav}
        onNavigate={(url) => window.easybow.navigate(url)}
        onBack={() => window.easybow.goBack()}
        onForward={() => window.easybow.goForward()}
        onReload={() => window.easybow.reload()}
        onTakeover={() => (status.state === 'running' ? window.easybow.pauseTask() : window.easybow.resumeTask())}
        onHistory={() => setHistoryOpen((v) => !v)}
        historyOpen={historyOpen}
        onTest={() => {
          setTestOpen(true)
          setTestCollapsed(false)
        }}
        onSettings={() => setSettingsOpen(true)}
        panelCollapsed={panelCollapsed}
        onTogglePanel={() => setPanelCollapsed((v) => !v)}
        inputRef={addrRef}
      />
      <BookmarksBar
        bookmarks={bookmarks}
        activeUrl={activeTab?.url || ''}
        onOpen={(url) => window.easybow.navigate(url)}
        onRemove={(url) => saveBookmarks(bookmarks.filter((b) => b.url !== url))}
      />
      <div className="main">
        <div className="browser-slot" ref={slotRef}>
          <div className="browser-placeholder">
            {overlayOpen ? (
              <>
                <span className="ph-icon"><SettingsIcon size={22} strokeWidth={2} /></span>
                <span>浏览器已暂时隐藏，关闭弹窗后自动恢复（页面状态不丢失）</span>
              </>
            ) : (
              <>
                <span className="ph-icon"><Globe size={22} strokeWidth={2} /></span>
                <span>浏览器区域加载中…</span>
              </>
            )}
          </div>
        </div>
        <TaskPanel
          status={status}
          steps={steps}
          settings={settings}
          ocr={ocr}
          task={task}
          setTask={setTask}
          collapsed={panelCollapsed}
          onExpandPanel={() => setPanelCollapsed(false)}
          onExpandEditor={() => setTaskEditorOpen(true)}
          onOpenKB={() => setKbOpen(true)}
          onOpenSchedule={() => setScheduleOpen(true)}
          onToast={pushToast}
          onShotClick={setViewer}
        />
      </div>

      {taskEditorMounted && (
        <TaskEditorModal
          open={taskEditorOpen}
          task={task}
          setTask={setTask}
          onClose={() => setTaskEditorOpen(false)}
        />
      )}
      {historyOpen && (
        <HistoryDropdown
          onClose={() => setHistoryOpen(false)}
          onOpen={(url, newTab) => {
            setHistoryOpen(false)
            if (newTab) window.easybow.newTab(url)
            else window.easybow.navigate(url)
          }}
          onToast={pushToast}
          topOffset={countdown ? COUNTDOWN_H : 0}
        />
      )}
      {/* 常驻挂载：切到其它弹窗再回来时，用例草稿（可能写了很久）不会丢失 */}
      {kbMounted && <KnowledgeModal open={kbOpen} onClose={() => setKbOpen(false)} />}
      {scheduleMounted && (
        <ScheduleModal
          open={scheduleOpen}
          initialTask={task}
          initialTestCase={scheduleTestCase || undefined}
          onClose={() => {
            setScheduleOpen(false)
            setScheduleTestCase(null)
          }}
          onToast={pushToast}
        />
      )}
      <TestPanel
        open={testOpen}
        collapsed={testCollapsed}
        onCollapsedChange={setTestCollapsed}
        onClose={() => {
          setTestOpen(false)
          setTestCollapsed(false)
        }}
        onToast={pushToast}
        onScheduleCase={(entry) => {
          setScheduleTestCase(entry)
          setScheduleOpen(true)
        }}
      />
      {settingsOpen && (
        <SettingsModal
          open={settingsOpen}
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            setSettings(s)
            setSettingsOpen(false)
            pushToast('设置已保存', 'success')
          }}
        />
      )}
      {viewerMounted && viewer && (
        <div className="img-viewer" onClick={() => setViewer(null)}>
          <img src={viewer} alt="步骤截图" />
        </div>
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.kind}${t.closing ? ' is-closing' : ''}`}
            onClick={() => dropToast(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}