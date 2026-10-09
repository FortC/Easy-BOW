import { Plus, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { TabInfo } from '@shared/types'
import { MAX_TABS } from '@shared/types'

export default function TabBar(props: {
  tabs: TabInfo[]
  activeTabId: number
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}) {
  /** 左右方向键在页签间移动（与浏览器一致的心智模型） */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, id: number) => {
    const i = props.tabs.findIndex((t) => t.id === id)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onSelect(id)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const n = props.tabs[Math.min(i + 1, props.tabs.length - 1)]
      if (n) {
        props.onSelect(n.id)
        document.querySelector<HTMLElement>(`[data-tab-id="${n.id}"]`)?.focus()
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const n = props.tabs[Math.max(i - 1, 0)]
      if (n) {
        props.onSelect(n.id)
        document.querySelector<HTMLElement>(`[data-tab-id="${n.id}"]`)?.focus()
      }
    }
  }

  return (
    <div className="tabbar" role="tablist" aria-label="页签">
      {props.tabs.map((t) => (
        <div
          key={t.id}
          data-tab-id={t.id}
          className={`tab ${t.id === props.activeTabId ? 'active' : ''}`}
          role="tab"
          tabIndex={t.id === props.activeTabId ? 0 : -1}
          aria-selected={t.id === props.activeTabId}
          title={t.url}
          onClick={() => props.onSelect(t.id)}
          onKeyDown={(e) => onKeyDown(e, t.id)}
        >
          {t.loading && <span className="t-loading" aria-label="加载中" />}
          <span className="t-title">{t.title || '新页签'}</span>
          <button
            className="t-close"
            aria-label={`关闭页签 ${t.title || t.url}`}
            onClick={(e) => {
              e.stopPropagation()
              props.onClose(t.id)
            }}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
      ))}
      {props.tabs.length < MAX_TABS && (
        <button className="tab-new" title="新建页签（Ctrl+T）" aria-label="新建页签" onClick={props.onNew}>
          <Plus size={14} strokeWidth={2.5} />
        </button>
      )}
      <span className="app-title">EasyBow AI 浏览器</span>
    </div>
  )
}