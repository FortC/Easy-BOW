import type { TabInfo } from '@shared/types'
import { MAX_TABS } from '@shared/types'

export default function TabBar(props: {
  tabs: TabInfo[]
  activeTabId: number
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}) {
  return (
    <div className="tabbar">
      {props.tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === props.activeTabId ? 'active' : ''}`}
          onClick={() => props.onSelect(t.id)}
          title={t.url}
        >
          {t.loading && <span className="t-loading" />}
          <span className="t-title">{t.title || '新页签'}</span>
          <span
            className="t-close"
            onClick={(e) => {
              e.stopPropagation()
              props.onClose(t.id)
            }}
          >
            ✕
          </span>
        </div>
      ))}
      {props.tabs.length < MAX_TABS && (
        <button className="tab-new" title="新建页签" onClick={props.onNew}>
          ＋
        </button>
      )}
      <span className="app-title">EasyBow AI 浏览器</span>
    </div>
  )
}
