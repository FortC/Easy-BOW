import { useEffect, useState } from 'react'
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
  onSettings: () => void
}) {
  const [addr, setAddr] = useState('')
  const editing = useState(false)

  // 页签切换/导航时同步地址栏（用户没在编辑时）
  useEffect(() => {
    if (!editing[0]) setAddr(props.activeTab?.url || '')
  }, [props.activeTab?.url, props.activeTab?.id])

  const pauseable = props.agentState === 'running' || props.agentState === 'paused' || props.agentState === 'captcha'

  return (
    <div className="toolbar">
      <button className="nav-btn" title="后退" disabled={!props.activeTab?.canGoBack} onClick={props.onBack}>
        ←
      </button>
      <button className="nav-btn" title="前进" disabled={!props.activeTab?.canGoForward} onClick={props.onForward}>
        →
      </button>
      <button className="nav-btn" title="刷新" onClick={props.onReload}>
        ⟳
      </button>
      <input
        className="addr"
        value={addr}
        placeholder="输入网址或搜索词，回车打开"
        spellCheck={false}
        onChange={(e) => setAddr(e.target.value)}
        onFocus={(e) => {
          editing[1](true)
          e.target.select()
        }}
        onBlur={() => editing[1](false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && addr.trim()) {
            props.onNavigate(addr.trim())
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <button
        className="nav-btn fav-btn"
        title={props.isFav ? '移除收藏（收藏栏）' : '收藏当前网站（加入收藏栏）'}
        disabled={!props.activeTab?.url}
        onClick={props.onToggleFav}
        style={props.isFav ? { color: '#f5a623' } : undefined}
      >
        {props.isFav ? '★' : '☆'}
      </button>
      <button className={`nav-btn${props.historyOpen ? ' active' : ''}`} title="历史页面（快速重新打开）" onClick={props.onHistory}>
        🕐
      </button>
      {pauseable && (
        <button
          className={`btn ${props.agentState === 'running' ? 'warn' : 'primary'}`}
          onClick={props.onTakeover}
          title={props.agentState === 'running' ? '暂停 AI，人工接管操作浏览器' : 'AI 已暂停，点击继续'}
        >
          {props.agentState === 'running' ? '⏸ 人工接管' : '▶ 继续任务'}
        </button>
      )}
      <button className="nav-btn" title="设置" onClick={props.onSettings}>
        ⚙
      </button>
    </div>
  )
}
