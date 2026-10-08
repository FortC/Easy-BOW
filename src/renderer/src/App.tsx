import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, Bookmark, MainEvent, Schedule, Settings, StepRecord, TabInfo } from '@shared/types'
import { LAYOUT } from '@shared/types'
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

interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error' | 'captcha'
}

const IDLE_STATUS: AgentStatus = {
  state: 'idle',
  task: '',
  stepCount: 0,
  statusText: '空闲',
  usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
  memory: {}
}

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
  const [testOpen, setTestOpen] = useState(false)
  const [task, setTask] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ocr, setOcr] = useState<{ enabled: boolean; reason?: string }>({ enabled: false })
  const [viewer, setViewer] = useState<string | null>(null)
  /** 即将执行的定时任务倒计时（执行前 60s 内出现） */
  const [countdown, setCountdown] = useState<{ id: number; name: string; secondsLeft: number } | null>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const toastId = useRef(1)

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = toastId.current++
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'captcha' ? 12000 : 5000)
  }, [])

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
        case 'toast':
          pushToast(ev.message, ev.kind)
          break
        case 'ocr-status':
          setOcr({ enabled: ev.enabled, reason: ev.reason })
          break
        case 'schedules':
          break
        case 'schedule-countdown':
          setCountdown(ev.secondsLeft > 0 ? { id: ev.id, name: ev.name, secondsLeft: ev.secondsLeft } : null)
          break
      }
    })
    window.easybow.getAgentStatus().then(setStatus)
    window.easybow.getSettings().then(setSettings)
    return off
  }, [pushToast])

  // 新任务开始时清空时间线
  useEffect(() => {
    if (status.state === 'running' && status.stepCount === 0) setSteps([])
  }, [status.task])

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

  // 倒计时事件停止推送（已执行/已取消）2.5s 后自动隐藏倒计时条
  useEffect(() => {
    if (!countdown) return
    const t = window.setTimeout(() => setCountdown(null), 2500)
    return () => window.clearTimeout(t)
  }, [countdown])

  // 弹窗/截图查看器/历史面板打开时隐藏浏览器视图（原生视图会盖住渲染层弹窗），关闭恢复
  useEffect(() => {
    const hidden = settingsOpen || viewer != null || taskEditorOpen || kbOpen || historyOpen || scheduleOpen || testOpen
    window.easybow.setBrowserHidden(hidden)
  }, [settingsOpen, viewer, taskEditorOpen, kbOpen, historyOpen, scheduleOpen, testOpen])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const browserCovered = settingsOpen || viewer != null || taskEditorOpen || kbOpen || historyOpen || scheduleOpen || testOpen

  return (
    <div className="app">
      {countdown && (
        <div className="sched-countdown-bar">
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
        onTakeover={() =>
          status.state === 'running' ? window.easybow.pauseTask() : window.easybow.resumeTask()
        }
        onHistory={() => setHistoryOpen((v) => !v)}
        historyOpen={historyOpen}
        onTest={() => setTestOpen(true)}
        onSettings={() => setSettingsOpen(true)}
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
            {browserCovered ? (
              <>
                <span style={{ fontSize: 28 }}>⚙</span>
                <span>浏览器已暂时隐藏，关闭弹窗后自动恢复（页面状态不丢失）</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 28 }}>🌐</span>
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
          onExpandEditor={() => setTaskEditorOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenKB={() => setKbOpen(true)}
          onOpenSchedule={() => setScheduleOpen(true)}
          onToast={pushToast}
          onShotClick={setViewer}
        />
      </div>

      {taskEditorOpen && (
        <TaskEditorModal task={task} setTask={setTask} onClose={() => setTaskEditorOpen(false)} />
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
        />
      )}
      {kbOpen && <KnowledgeModal onClose={() => setKbOpen(false)} />}
      {scheduleOpen && (
        <ScheduleModal initialTask={task} onClose={() => setScheduleOpen(false)} onToast={pushToast} />
      )}
      {testOpen && <TestPanel onClose={() => setTestOpen(false)} onToast={pushToast} />}
      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            setSettings(s)
            setSettingsOpen(false)
            pushToast('设置已保存', 'success')
          }}
        />
      )}
      {viewer && (
        <div className="img-viewer" onClick={() => setViewer(null)}>
          <img src={viewer} alt="步骤截图" />
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
