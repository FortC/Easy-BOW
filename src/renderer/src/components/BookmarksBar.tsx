import type { Bookmark } from '@shared/types'

/** 收藏栏：常去站点一键打开（空时不占空间） */
export default function BookmarksBar(props: {
  bookmarks: Bookmark[]
  activeUrl: string
  onOpen: (url: string) => void
  onRemove: (url: string) => void
}) {
  if (!props.bookmarks.length) return null
  return (
    <div className="favbar">
      <span className="favbar-label" title="收藏的站点">
        ★
      </span>
      <div className="favbar-list">
        {props.bookmarks.map((b) => (
          <span
            key={b.url}
            className={`fav-chip ${b.url === props.activeUrl ? 'active' : ''}`}
            title={b.url}
            onClick={() => props.onOpen(b.url)}
          >
            <span className="fav-chip-text">{b.title || b.url}</span>
            <span
              className="fav-chip-x"
              title="移除收藏"
              onClick={(e) => {
                e.stopPropagation()
                props.onRemove(b.url)
              }}
            >
              ✕
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
