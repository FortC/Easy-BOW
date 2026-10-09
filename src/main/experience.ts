/**
 * 记忆进化 S5 —— AI 自动沉淀的经验库（区别于 knowledge.ts 的人工经验库）。
 *
 * 三类经验：
 * - field_map 站点字段映射：任务意图词 → 实际字段名（语义校验通过时自动写入）
 * - lesson    失败教训：人工纠正后该步成功时写入
 * - path      成功路径：任务成功完成时写入节点链摘要
 *
 * 置信度：命中且任务成功 score++；命中但后续失败 score--；score ≤ -2 自动停用。
 * 上限 200 条，按 score 与 updatedAt 淘汰。UI 可查看/删除（设置弹窗）。
 */
import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { writeJsonAtomic } from './fsutil'
import { join } from 'path'
import { extractFillFields, normalize } from './semantic'

export interface ExperienceEntry {
  id: number
  /** 适用站点域名（空=全局） */
  domain: string
  kind: 'field_map' | 'lesson' | 'path'
  /** 匹配键（field_map=意图词 / path=任务摘要 / lesson=失败类型） */
  key: string
  /** 值（field_map=实际字段名 / path=节点链 / lesson=正确做法） */
  value: string
  /** 置信度：命中成功++ / 命中失败--；≤ -2 自动停用 */
  score: number
  createdAt: number
  updatedAt: number
  enabled: boolean
}

const MAX_ENTRIES = 200
const filePath = () => join(app.getPath('userData'), 'experience.json')

let cached: ExperienceEntry[] | null = null

function load(): ExperienceEntry[] {
  if (cached) return cached
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf-8'))
      cached = Array.isArray(raw)
        ? raw.filter((e: ExperienceEntry) => e && typeof e.key === 'string' && typeof e.value === 'string')
        : []
    } else {
      cached = []
    }
  } catch {
    cached = []
  }
  return cached!
}

let saveTimer: NodeJS.Timeout | null = null

function save(): void {
  // 节流：长任务里 upsert/feedback 高频触发，每次都同步写盘会反复阻塞主进程——
  // 800ms 内合并为一次落盘（内存 cached 即时生效，丢电最多丢最后 800ms 的增量）
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      // 淘汰：优先保留高分与最近更新的，上限 200 条
      const all = load()
      if (all.length > MAX_ENTRIES) {
        all.sort((a, b) => (b.score - a.score) || (b.updatedAt - a.updatedAt))
        cached = all.slice(0, MAX_ENTRIES)
      }
      writeJsonAtomic(filePath(), cached || [])
    } catch (e) {
      console.error('[easybow] 保存经验库失败:', e)
    }
  }, 800)
  saveTimer.unref?.()
}

/** 退出前强制落盘（应用 cleanup 调用，防节流窗口内的增量丢失） */
export function flushExperience(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    writeJsonAtomic(filePath(), cached || [])
  } catch {}
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 全量列表（UI 用） */
export function getExperience(): ExperienceEntry[] {
  return JSON.parse(JSON.stringify(load())) as ExperienceEntry[]
}

/** 全量覆盖（UI 删除/停用用） */
export function setExperience(entries: ExperienceEntry[]): ExperienceEntry[] {
  cached = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.key === 'string' && typeof e.value === 'string')
    .map((e, i) => ({
      id: typeof e.id === 'number' ? e.id : Date.now() + i,
      domain: String(e.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      kind: e.kind === 'lesson' || e.kind === 'path' ? e.kind : 'field_map',
      key: String(e.key).slice(0, 60),
      value: String(e.value).slice(0, 400),
      score: Number.isFinite(e.score) ? Number(e.score) : 0,
      createdAt: e.createdAt || Date.now(),
      updatedAt: e.updatedAt || Date.now(),
      enabled: e.enabled !== false
    }))
  save()
  return JSON.parse(JSON.stringify(cached || [])) as ExperienceEntry[]
}

/**
 * 写入/更新一条经验（同 domain+kind+key 幂等合并，只刷新 value 与 updatedAt）。
 * 全部 try/catch 静默——经验沉淀绝不能影响任务主流程。
 */
export function upsertExperience(e: {
  domain: string
  kind: ExperienceEntry['kind']
  key: string
  value: string
}): void {
  try {
    const all = load()
    const domain = String(e.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const key = normalize(e.key).slice(0, 60)
    const value = String(e.value || '').trim().slice(0, 400)
    if (!key || !value) return
    const hit = all.find((x) => x.domain === domain && x.kind === e.kind && normalize(x.key) === key)
    if (hit) {
      hit.value = value
      hit.updatedAt = Date.now()
    } else {
      all.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        domain,
        kind: e.kind,
        key: e.key.slice(0, 60),
        value,
        score: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true
      })
    }
    save()
  } catch {}
}

function domainMatch(entryDomain: string, host: string): boolean {
  if (!entryDomain) return true
  if (!host) return false
  return host === entryDomain || host.endsWith('.' + entryDomain)
}

/**
 * 匹配当前页面 + 任务的已有经验，产出注入提示词的行（优先级高于模型直觉）。
 * - field_map：意图词与任务的填写字段吻合 → 「商品名称 → 实际字段「名称」」
 * - lesson：该站点全部教训（最近 3 条）
 * - path：同站点且任务前 8 字吻合的成功路径
 */
export function matchExperience(url: string, task: string): string[] {
  try {
    const all = load()
    if (!all.length) return []
    const host = hostOf(url)
    const fills = extractFillFields(task).map(normalize)
    const taskKey = normalize(task).slice(0, 8)
    const lines: string[] = []
    for (const e of all) {
      if (!e.enabled || !domainMatch(e.domain, host)) continue
      if (e.kind === 'field_map') {
        const k = normalize(e.key)
        if (k && fills.some((f) => f.includes(k) || k.includes(f))) {
          lines.push(`- [field_map] ${e.key} → 实际字段「${e.value.slice(0, 30)}」(已验证 ${Math.max(0, e.score)} 次)`)
        }
      } else if (e.kind === 'lesson') {
        if (lines.filter((l) => l.startsWith('- [lesson]')).length < 3) {
          lines.push(`- [lesson] ${e.value.slice(0, 150)}`)
        }
      } else if (e.kind === 'path') {
        const k = normalize(e.key)
        if (taskKey && (k.startsWith(taskKey.slice(0, 6)) || taskKey.startsWith(k.slice(0, 6)))) {
          lines.push(`- [path] 上次同类任务路径: ${e.value.slice(0, 150)}`)
        }
      }
      if (lines.length >= 8) break
    }
    return lines
  } catch {
    return []
  }
}

/** 命中回分：任务结束时按「该页面+任务匹配到的经验」统一 +1 / -1；≤ -2 自动停用 */
export function feedbackExperience(url: string, task: string, ok: boolean): void {
  try {
    const all = load()
    const host = hostOf(url)
    const fills = extractFillFields(task).map(normalize)
    const taskKey = normalize(task).slice(0, 8)
    let touched = false
    for (const e of all) {
      if (!e.enabled || !domainMatch(e.domain, host)) continue
      const k = normalize(e.key)
      const hit =
        (e.kind === 'field_map' && k && fills.some((f) => f.includes(k) || k.includes(f))) ||
        (e.kind === 'path' && taskKey && (k.startsWith(taskKey.slice(0, 6)) || taskKey.startsWith(k.slice(0, 6)))) ||
        e.kind === 'lesson'
      if (!hit) continue
      e.score += ok ? 1 : -1
      e.updatedAt = Date.now()
      if (e.score <= -2) e.enabled = false
      touched = true
    }
    if (touched) save()
  } catch {}
}
