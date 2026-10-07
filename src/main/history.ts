import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '@shared/types'

const MAX_ENTRIES = 500
const SAVE_DEBOUNCE_MS = 800

const historyPath = () => join(app.getPath('userData'), 'history.json')

/** 内存缓存（最新在前），防抖落盘，重启不丢 */
let entries: HistoryEntry[] | null = null
let saveTimer: NodeJS.Timeout | null = null

function load(): HistoryEntry[] {
  if (entries) return entries
  try {
    if (existsSync(historyPath())) {
      const raw = JSON.parse(readFileSync(historyPath(), 'utf-8'))
      entries = Array.isArray(raw)
        ? raw
            .filter((e: any) => e && typeof e.url === 'string' && /^https?:/i.test(e.url))
            .slice(0, MAX_ENTRIES)
            .map((e: any) => ({ url: e.url, title: String(e.title || ''), ts: Number(e.ts) || 0, count: Math.max(1, Number(e.count) || 1) }))
        : []
    } else {
      entries = []
    }
  } catch {
    entries = []
  }
  return entries!
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(historyPath(), JSON.stringify(load().slice(0, MAX_ENTRIES)), 'utf-8')
    } catch (e) {
      console.error('[easybow] 保存历史记录失败:', e)
    }
  }, SAVE_DEBOUNCE_MS)
}

/** 记录一次访问：同 URL 提到最前并累计次数；连续重复只刷新时间与标题 */
export function recordHistory(url: string, title: string): void {
  if (!/^https?:/i.test(url)) return // 只记网页，跳过 about:blank / file: 等
  const list = load()
  const t = (title || '').slice(0, 120)
  const top = list[0]
  const existing = list.find((e) => e.url === url)
  if (existing) {
    list.splice(list.indexOf(existing), 1)
    existing.title = t || existing.title
    existing.ts = Date.now()
    // 紧接着的重复导航（刷新/SPA 跳转）不重复计数
    if (!(top && top.url === url)) existing.count = (existing.count || 1) + 1
    list.unshift(existing)
  } else {
    list.unshift({ url, title: t, ts: Date.now(), count: 1 })
  }
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
  persist()
}

/** 标题补全：导航后页面 title 更新时回填（按 URL 匹配最近一条） */
export function touchHistoryTitle(url: string, title: string): void {
  if (!title) return
  const e = load().find((x) => x.url === url)
  if (e && e.title !== title) {
    e.title = title.slice(0, 120)
    persist()
  }
}

/** 查询：关键词过滤标题/URL（大小写不敏感），最新在前 */
export function listHistory(query?: string, limit = 200): HistoryEntry[] {
  const q = (query || '').trim().toLowerCase()
  const list = load()
  if (!q) return list.slice(0, limit)
  return list
    .filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
    .slice(0, limit)
}

export function removeHistory(url: string): void {
  const list = load()
  const i = list.findIndex((e) => e.url === url)
  if (i !== -1) {
    list.splice(i, 1)
    persist()
  }
}

export function clearHistory(): void {
  entries = []
  persist()
}
