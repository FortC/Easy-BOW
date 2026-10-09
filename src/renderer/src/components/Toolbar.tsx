import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  FlaskConical,
  History,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  RotateCw,
  Settings,
  Star
} from 'lucide-react'
import type { AgentRunState, TabInfo } from '@shared/types'

export default function Toolbar(props: {
  activeTab?: TabInfo
  agentState: AgentRunState
  isFav: boolean
  onToggleFav: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onTakeover: () => void
  onHistory: () => void
  historyOpen: boolean
  onTest: () => void
  onSettings: () => void
  /** 右侧面板是否已折叠 */
  panelCollapsed: boolean
  onTogglePanel: () => void
  /** 地址栏 DOM 引用，供 App 的 Ctrl+L 快捷键聚焦 */
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const [addr, setAddr] = useState('')
  // 用 ref 而非 useState 数组：编辑态只需「当下」的值、不该触发重渲染，
  // 且地址栏 effect 读它时不会被闭包快照误导（否则用户正输入时切页签会覆盖输入）
  const editingRef = useRef(false)

  // 页签切换/导航时同步地址栏（用户没在编辑时）
  useEffect(() => {
    if (!editingRef.current) setAddr(props.activeTab?.url || '')
  }, [props.activeTab?.url, props.activeTab?.id])

  const pauseable = props.agentState === 'running' || props.agentState === 'paused' || props.agentState === 'captcha'

  return (
    <div className="toolbar">
      <button className="nav-btn" title="后退" aria-label="后退" disabled={!props.activeTab?.canGoBack} onClick={props.onBack}>
        <ArrowLeft size={16} strokeWidth={2} />
      </button>
      <button className="nav-btn" title="前进" aria-label="前进" disabled={!props.activeTab?.canGoForward} onClick={props.onForward}>
        <ArrowRight size={16} strokeWidth={2} />
      </button>
      <button className="nav-btn" title="刷新（F5）" aria-label="刷新" onClick={props.onReload}>
        <RotateCw size={16} strokeWidth={2} />
      </button>
      <input
        ref={props.inputRef}
        className="addr"
        value={addr}
        placeholder="输入网址或搜索词，回车打开（Ctrl+L 聚焦）"
        spellCheck={false}
        aria-label="地址栏"
        onChange={(e) => setAddr(e.target.value)}
        onFocus={(e) => {
          editingRef.current = true
          e.target.select()
        }}
        onBlur={() => (editingRef.current = false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && addr.trim()) {
            props.onNavigate(addr.trim())
            editingRef.current = false
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            // Esc 放弃编辑并还原为当前页签地址
            setAddr(props.activeTab?.url || '')
            editingRef.current = false
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <button
        className="nav-btn with-label fav-btn"
        title={props.isFav ? '移除收藏（收藏栏）' : '收藏当前网站（加入收藏栏）'}
        aria-label={props.isFav ? '移除收藏' : '收藏当前网站'}
        aria-pressed={props.isFav}
        disabled={!props.activeTab?.url}
        onClick={props.onToggleFav}
        style={props.isFav ? { color: '#f5a623' } : undefined}
      >
        <Star size={16} strokeWidth={2} fill={props.isFav ? 'currentColor' : 'none'} />
        <span className="lbl">收藏</span>
      </button>
      <button
        className={`nav-btn with-label${props.historyOpen ? ' active' : ''}`}
        title="历史页面（快速重新打开）"
        aria-label="历史页面"
        aria-expanded={props.historyOpen}
        onClick={props.onHistory}
      >
        <History size={16} strokeWidth={2} />
        <span className="lbl">历史</span>
      </button>
      <button className="nav-btn with-label" title="浏览器仿真测试（需求→用例→执行→报告）" aria-label="浏览器仿真测试" onClick={props.onTest}>
        <FlaskConical size={16} strokeWidth={2} />
        <span className="lbl">测试</span>
      </button>
      {pauseable && (
        <button
          className={`btn ${props.agentState === 'running' ? 'warn' : 'primary'}`}
          onClick={props.onTakeover}
          title={props.agentState === 'running' ? '暂停 AI，人工接管操作浏览器' : 'AI 已暂停，点击继续'}
        >
          {props.agentState === 'running' ? (
            <>
              <Pause size={14} strokeWidth={2} /> 人工接管
            </>
          ) : (
            <>
              <Play size={14} strokeWidth={2} /> 继续任务
            </>
          )}
        </button>
      )}
      <button
        className="nav-btn with-label"
        title={props.panelCollapsed ? '展开 AI 任务面板（Ctrl+B）' : '收起 AI 任务面板，把整屏留给网页（Ctrl+B）'}
        aria-label={props.panelCollapsed ? '展开任务面板' : '收起任务面板'}
        aria-pressed={props.panelCollapsed}
        onClick={props.onTogglePanel}
      >
        {props.panelCollapsed ? <PanelRightOpen size={16} strokeWidth={2} /> : <PanelRightClose size={16} strokeWidth={2} />}
        <span className="lbl">面板</span>
      </button>
      <button className="nav-btn with-label" title="设置" aria-label="设置" onClick={props.onSettings}>
        <Settings size={16} strokeWidth={2} />
        <span className="lbl">设置</span>
      </button>
    </div>
  )
}