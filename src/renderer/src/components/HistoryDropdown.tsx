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
    <div className="hist-backdrop" onClick={props.onClose}>
      <div className="hist-panel" onClick={(e) => e.stopPropagation()} style={{ top: LAYOUT.TAB_BAR_H + LAYOUT.TOOLBAR_H + 6 }}>
        <div className="hist-search">
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索历史（标题 / 网址）…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="hist-count">{entries ? `${filtered.length} 条` : '…'}</span>
        </div>
        <div className="hist-list">
          {entries === null && <div className="hist-empty">加载中…</div>}
          {entries !== null && filtered.length === 0 && (
            <div className="hist-empty">{query ? '没有匹配的历史记录' : '还没有历史记录，浏览过的页面会出现在这里'}</div>
          )}
          {filtered.map((e) => (
            <div
              key={e.url}
              className="hist-item"
              title={`${e.title || e.url}\n${e.url}\n单击：当前页签打开 · 中键/⊕：新页签打开`}
              onClick={() => props.onOpen(e.url, false)}
              onAuxClick={(ev) => {
                if (ev.button === 1) props.onOpen(e.url, true)
              }}
            >
              {(() => {
                const fav = faviconOf(e.url)
                return fav ? <Favicon src={fav} /> : <span className="hist-fav">🌐</span>
              })()}
              <div className="hist-info">
                <div className="hist-title">{e.title || e.url}</div>
                <div className="hist-url">
                  {hostOf(e.url)}
                  {e.count > 1 && <span className="hist-visits"> · 访问{e.count}次</span>}
                </div>
              </div>
              <span className="hist-time">{relTime(e.ts)}</span>
              <button
                className="hist-op"
                title="在新页签打开"
                onClick={(ev) => {
                  ev.stopPropagation()
                  props.onOpen(e.url, true)
                }}
              >
                ⊕
              </button>
              <button
                className="hist-op"
                title="从历史中删除"
                onClick={(ev) => {
                  ev.stopPropagation()
                  remove(e.url)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="hist-foot">
          <span className="hist-foot-tip">单击在当前页签打开 · ⊕ 新页签打开</span>
          {!!entries?.length && (
            <button className="hist-clear" onClick={clear}>
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
  if (failed) return <span className="hist-fav">🌐</span>
  return <img className="hist-fav" src={props.src} alt="" onError={() => setFailed(true)} />
}
