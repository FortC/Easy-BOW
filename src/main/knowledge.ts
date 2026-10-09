import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { writeJsonAtomic } from './fsutil'
import { join } from 'path'
import type { KBEntry } from '@shared/types'

/**
 * 问题经验库：用户积累的「某站点某问题的正确处理方式」，
 * 每步按当前页签域名匹配后注入 AI 提示词，避免 AI 重复犯同样的错。
 */

const kbPath = () => join(app.getPath('userData'), 'knowledge.json')

/** 首次使用预置的典型案例（用户可在界面里修改/删除） */
const SEED: KBEntry[] = [
  {
    id: 1,
    domain: 'docs.qq.com',
    problem: '往腾讯文档写内容时找不到输入框',
    solution:
      '腾讯文档的正文不是输入框：直接 click 正文文字区域即可进入编辑状态（正文是可编辑区域），然后对正文元素 type 输入。禁止使用浏览器查找(Ctrl+F)输入内容。',
    enabled: true
  }
]

let cached: KBEntry[] | null = null

export function getKB(): KBEntry[] {
  if (cached) return cached
  try {
    if (existsSync(kbPath())) {
      const raw = JSON.parse(readFileSync(kbPath(), 'utf-8'))
      cached = Array.isArray(raw) ? raw.filter((e) => e && typeof e.solution === 'string') : []
    } else {
      cached = SEED
      save()
    }
  } catch {
    cached = []
  }
  return cached
}

export function setKB(entries: KBEntry[]): KBEntry[] {
  cached = entries
    .filter((e) => e && String(e.solution || '').trim())
    .slice(0, 50)
    .map((e, i) => ({
      id: typeof e.id === 'number' ? e.id : Date.now() + i,
      domain: String(e.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      problem: String(e.problem || '').slice(0, 80),
      solution: String(e.solution).slice(0, 400),
      enabled: e.enabled !== false
    }))
  save()
  return cached
}

function save(): void {
  try {
    writeJsonAtomic(kbPath(), cached || [])
  } catch (e) {
    console.error('[easybow] 保存经验库失败:', e)
  }
}

/** 取与当前 URL 匹配的经验条目（域名完全相同或为其子域；无域名的条目全局适用） */
export function matchKB(url: string): KBEntry[] {
  let host = ''
  try {
    host = new URL(url).host
  } catch {}
  return getKB().filter((e) => {
    if (!e.enabled) return false
    if (!e.domain) return true
    if (!host) return false
    return host === e.domain || host.endsWith('.' + e.domain)
  })
}
