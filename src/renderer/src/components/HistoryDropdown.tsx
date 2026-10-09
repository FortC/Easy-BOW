import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { LAYOUT } from '@shared/types'

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + '分钟前'
  if (d < 86400000) return Math.floor(d / 3600000) + '小时前'
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + '天前'
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function faviconOf(url: string): string | null {
  try {
    return new URL('/favicon.ico', url).href
  } catch {
    return null
  }
}

/** 历史页面下拉：搜索 + 快速打开（当前页签 / 新页签）+ 删除/清空 */
export default function HistoryDropdown(props: {
  onClose: () => void
  onOpen: (url: string, newTab: boolean) => void
  onToast: (msg: string, kind?: 'info' | 'success' | 'error') => void
  /** 顶部被定时任务倒计时条撑高时的额外偏移（px），避免面板错位 */
  topOffset?: number
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    window.easybow
      .listHistory()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => !removed.has(e.url) && (e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
    )
  }, [entries, query, removed])

  const remove = async (url: string) => {
    setRemoved((s) => new Set(s).add(url))
    try {
      await window.easybow.removeHistory(url)
    } catch {
      props.onToast('删除失败', 'error')
      setRemoved((s) => {
        const n = new Set(s)
        n.delete(url)
        return n
      })
    }
  }

  const clear = async () => {
    try {
      await window.easybow.clearHistory()
      setEntries([])
      props.onToast('历史记录已清空', 'info')
    } catch {
      props.onToast('清空失败', 'error')
    }
  }

  return (
    <div className="hdrop-backdrop" onClick={props.onClose}>
      <div
        className="hdrop-panel"
        role="dialog"
        aria-label="历史页面"
        onClick={(e) => e.stopPropagation()}
        style={{ top: LAYOUT.TAB_BAR_H + LAYOUT.TOOLBAR_H + 6 + (props.topOffset || 0) }}
      >
        <div className="hdrop-search">
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索历史（标题 / 网址）…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="hdrop-count">{entries ? `${filtered.length} 条` : '…'}</span>
        </div>
        <div className="hdrop-list">
          {/* 加载中：用骨架屏占位，避免「加载中…」文字与空态文案来回跳变 */}
          {entries === null && (
            <>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton skeleton-row" style={{ opacity: 1 - i * 0.16 }} />
              ))}
            </>
          )}
          {entries !== null && filtered.length === 0 && (
            <div className="hdrop-empty">{query ? '没有匹配的历史记录' : '还没有历史记录，浏览过的页面会出现在这里'}</div>
          )}
          {filtered.map((e) => (
            <div
              key={e.url}
              className="hdrop-row"
              role="button"
              tabIndex={0}
              title={`${e.title || e.url}\n${e.url}\n单击：当前页签打开 · 空格/中键：新页签打开`}
              onClick={() => props.onOpen(e.url, false)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  ev.preventDefault()
                  props.onOpen(e.url, false)
                } else if (ev.key === ' ') {
                  ev.preventDefault()
                  props.onOpen(e.url, true)
                }
              }}
              onAuxClick={(ev) => {
                if (ev.button === 1) props.onOpen(e.url, true)
              }}
            >
              {(() => {
                const fav = faviconOf(e.url)
                return fav ? <Favicon src={fav} /> : <span className="hdrop-fav">🌐</span>
              })()}
              <div className="hdrop-info">
                <div className="hdrop-title">{e.title || e.url}</div>
                <div className="hdrop-url">
                  {hostOf(e.url)}
                  {e.count > 1 && <span className="hdrop-visits"> · 访问{e.count}次</span>}
                </div>
              </div>
              <span className="hdrop-time">{relTime(e.ts)}</span>
              <button
                className="hdrop-op"
                title="在新页签打开"
                aria-label={`在新页签打开 ${e.title || e.url}`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  props.onOpen(e.url, true)
                }}
              >
                ⊕
              </button>
              <button
                className="hdrop-op"
                title="从历史中删除"
                aria-label={`从历史中删除 ${e.title || e.url}`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  remove(e.url)
                }}
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          ))}
        </div>
        <div className="hdrop-foot">
          <span className="hdrop-foot-tip">单击在当前页签打开 · 空格/⊕ 新页签打开</span>
          {!!entries?.length && (
            <button className="hdrop-clear" onClick={clear}>
              清空历史
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** favicon 加载失败回退为 🌐 */
function Favicon(props: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="hdrop-fav">🌐</span>
  return <img className="hdrop-fav" src={props.src} alt="" onError={() => setFailed(true)} />
}