/**
 * 测试环境档案 + 报告索引（userData 持久化，与 Settings 完全分离，互不影响）。
 */
import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { writeJsonAtomic } from '../fsutil'
import { join } from 'path'
import type { TestCaseEntry, TestEnv } from '@shared/types'
import { reportsRoot } from './report'

const envsPath = () => join(app.getPath('userData'), 'test-envs.json')

export function getTestEnvs(): TestEnv[] {
  try {
    if (existsSync(envsPath())) {
      const raw = JSON.parse(readFileSync(envsPath(), 'utf-8'))
      if (Array.isArray(raw)) {
        return raw
          .filter((e: any) => e && typeof e.name === 'string')
          .map((e: any) => ({
            name: String(e.name).slice(0, 30),
            baseUrl: String(e.baseUrl || '').slice(0, 300),
            protected: !!e.protected
          }))
      }
    }
  } catch {}
  return []
}

export function saveTestEnvs(envs: TestEnv[]): TestEnv[] {
  const clean = envs
    .filter((e) => e && e.name && e.name.trim())
    .map((e) => ({ name: e.name.trim().slice(0, 30), baseUrl: (e.baseUrl || '').trim().slice(0, 300), protected: !!e.protected }))
  try {
    writeJsonAtomic(envsPath(), clean)
  } catch (e) {
    console.error('[easybow] 测试环境保存失败:', e)
  }
  return clean
}

export function findTestEnv(name?: string): TestEnv | undefined {
  if (!name) return undefined
  return getTestEnvs().find((e) => e.name === name)
}

export interface ReportEntry {
  file: string
  ts: number
  verdict: string
}

/** 报告列表：扫描 reports 下各 run 目录的 report.md，读首屏判定结论（无索引文件，零维护） */
export function listReports(): ReportEntry[] {
  const root = reportsRoot()
  const out: ReportEntry[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root).filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return out
  }
  for (const d of dirs) {
    try {
      const p = join(root, d, 'report.md')
      if (!existsSync(p)) continue
      const head = readFileSync(p, 'utf-8').slice(0, 400)
      const vm = head.match(/\*\*结果\*\*: (.+)/)
      out.push({ file: d, ts: statSync(p).mtimeMs, verdict: vm ? vm[1] : '未知' })
    } catch {}
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 50)
}

export function readReport(dirName: string): string {
  const safe = dirName.replace(/[\\/:*?"<>|]/g, '_')
  const p = join(reportsRoot(), safe, 'report.md')
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    throw new Error('报告不存在或已删除')
  }
}

// —————— 用例库（应用内保存的测试用例） ——————

const casesPath = () => join(app.getPath('userData'), 'test-cases.json')

function loadCases(): TestCaseEntry[] {
  try {
    if (existsSync(casesPath())) {
      const raw = JSON.parse(readFileSync(casesPath(), 'utf-8'))
      if (Array.isArray(raw)) {
        return raw.filter((c: any) => c && typeof c.id === 'number' && typeof c.md === 'string')
      }
    }
  } catch {}
  return []
}

function persistCases(list: TestCaseEntry[]): void {
  try {
    writeJsonAtomic(casesPath(), list)
  } catch (e) {
    console.error('[easybow] 用例库保存失败:', e)
  }
}

export function listTestCases(): TestCaseEntry[] {
  return loadCases()
}

export function getTestCase(id: number): TestCaseEntry | undefined {
  return loadCases().find((c) => c.id === id)
}

/** 新建（无 id）或更新（带 id，按 name/md/tags 覆盖）；返回全量列表 */
export function saveTestCase(input: { name: string; md: string; tags?: string[]; id?: number }): TestCaseEntry[] {
  const list = loadCases()
  const name = (input.name || '未命名用例').slice(0, 60)
  const md = String(input.md || '')
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : []
  if (input.id != null) {
    const s = list.find((c) => c.id === input.id)
    if (!s) throw new Error(`用例 ${input.id} 不存在`)
    s.name = name
    s.md = md
    s.tags = tags
  } else {
    const id = Math.max(0, ...list.map((c) => c.id)) + 1
    list.unshift({ id, name, md, tags, createdAt: Date.now() })
  }
  persistCases(list)
  return list
}

export function deleteTestCase(id: number): TestCaseEntry[] {
  const list = loadCases().filter((c) => c.id !== id)
  persistCases(list)
  return list
}

/** 运行结束回写统计（最近一次运行时间与结论，供用例库列表展示） */
export function updateCaseRunStat(id: number, verdict: string): void {
  const list = loadCases()
  const s = list.find((c) => c.id === id)
  if (!s) return
  s.lastRunAt = Date.now()
  s.lastVerdict = verdict.slice(0, 40)
  persistCases(list)
}
