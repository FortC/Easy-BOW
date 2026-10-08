/**
 * 测试环境档案 + 报告索引（userData 持久化，与 Settings 完全分离，互不影响）。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { TestEnv } from '@shared/types'
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
    writeFileSync(envsPath(), JSON.stringify(clean, null, 2), 'utf-8')
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
