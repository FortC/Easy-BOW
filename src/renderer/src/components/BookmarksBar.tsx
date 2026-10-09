import { Star, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { Bookmark } from '@shared/types'

/** 收藏栏：常去站点一键打开（空时不占空间） */
export default function BookmarksBar(props: {
  bookmarks: Bookmark[]
  activeUrl: string
  onOpen: (url: string) => void
  onRemove: (url: string) => void
}) {
  if (!props.bookmarks.length) return null

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>, url: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onOpen(url)
    }
  }

  return (
    <div className="favbar" aria-label="收藏栏">
      <span className="favbar-label" title="收藏的站点">
        <Star size={12} strokeWidth={2} fill="currentColor" />
      </span>
      <div className="favbar-list">
        {props.bookmarks.map((b) => (
          <span
            key={b.url}
            className={`fav-chip ${b.url === props.activeUrl ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`打开收藏 ${b.title || b.url}`}
            title={b.url}
            onClick={() => props.onOpen(b.url)}
            onKeyDown={(e) => onKeyDown(e, b.url)}
          >
            <span className="fav-chip-text">{b.title || b.url}</span>
            <button
              className="fav-chip-x"
              title="移除收藏"
              aria-label={`移除收藏 ${b.title || b.url}`}
              onClick={(e) => {
                e.stopPropagation()
                props.onRemove(b.url)
              }}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}