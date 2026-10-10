/**
 * 回归报告（T1）：Markdown 落盘 reports/regression/<yyyyMMdd-HHmmss>.md（仓库根目录，便于 CI 收集）。
 * 内容：成功率（agent 口径）/ 失败三分类列示 / 每用例步数 / P50-P90 步耗时 / token 消耗 / 失败原因摘要。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CaseResult } from './types'
import type { FailureTriage } from '../telemetry'

/** 最近秩百分位（P50/P90）；空数组返回 0 */
export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

export function collectStepMs(results: CaseResult[]): number[] {
  return results.flatMap((r) => r.stepMs).sort((a, b) => a - b)
}

const statusMark = (s: CaseResult['status']): string => (s === 'passed' ? '✅ 通过' : s === 'failed' ? '❌ 失败' : '⏭️ 跳过')

const triageText: Record<FailureTriage, string> = {
  agent: 'agent（计入成功率）',
  infra: 'infra（环境，不计入）',
  product: 'product（产品 bug，单列）'
}

function fmtMin(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function buildReportMarkdown(results: CaseResult[], startedAt: number): string {
  const passed = results.filter((r) => r.status === 'passed')
  const failed = results.filter((r) => r.status === 'failed')
  const skipped = results.filter((r) => r.status === 'skipped')
  // 成功率三分类（横切约束 3）：只有 agent 失败计入分母；infra/product 单列不计入
  const byTriage = (t: FailureTriage) => failed.filter((r) => r.triage === t)
  const agentFailed = byTriage('agent')
  const agentTotal = passed.length + agentFailed.length
  const rate = agentTotal ? ((passed.length / agentTotal) * 100).toFixed(1) : '—'
  const stepMs = collectStepMs(results)
  const tokensIn = results.reduce((s, r) => s + r.tokens.input, 0)
  const tokensOut = results.reduce((s, r) => s + r.tokens.output, 0)
  const totalSteps = results.reduce((s, r) => s + r.steps, 0)

  const L: string[] = []
  L.push(`# EasyBow 回归报告`)
  L.push('')
  L.push(`- **时间**: ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}`)
  L.push(`- **成功率（agent 口径）**: ${passed.length}/${agentTotal}（${rate}%）—— 通过/(通过+agent 失败)，infra/product 不计入`)
  L.push(`- **失败三分类**: agent ${byTriage('agent').length} · infra ${byTriage('infra').length} · product ${byTriage('product').length}`)
  L.push(`- **用例**: 共 ${results.length}，通过 ${passed.length}，失败 ${failed.length}，跳过 ${skipped.length}`)
  L.push(`- **步数合计**: ${totalSteps}`)
  L.push(`- **Token 消耗**: 输入 ${tokensIn} / 输出 ${tokensOut}`)
  L.push(`- **步耗时 P50/P90**: ${percentile(stepMs, 50)}ms / ${percentile(stepMs, 90)}ms（样本 ${stepMs.length} 步）`)
  L.push('')

  L.push('## 用例明细')
  L.push('')
  L.push('| # | 用例 | 来源 | 结果 | 分类 | 步数 | 耗时 | Token(入/出) | 失败/跳过原因 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  results.forEach((r, i) => {
    const reason = (r.reason || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
    L.push(
      `| ${i + 1} | ${r.name} | ${r.source} | ${statusMark(r.status)} | ${r.triage ? r.triage : '—'} | ${r.steps} | ${fmtMin(r.durationMs)} | ${r.tokens.input}/${r.tokens.output} | ${reason || '—'} |`
    )
  })
  L.push('')

  L.push('## 失败三分类')
  L.push('')
  for (const t of ['agent', 'infra', 'product'] as FailureTriage[]) {
    const list = byTriage(t)
    L.push(`### ${triageText[t]}`)
    L.push('')
    if (!list.length) {
      L.push('- （无）')
    } else {
      for (const r of list) L.push(`- **${r.name}**: ${r.reason || '（无摘要）'}`)
    }
    L.push('')
  }

  L.push('## 每用例步数与 P50/P90 步耗时')
  L.push('')
  L.push('| 用例 | 步数 | P50(ms) | P90(ms) |')
  L.push('|---|---|---|---|')
  for (const r of results) {
    const s = [...r.stepMs].sort((a, b) => a - b)
    L.push(`| ${r.name} | ${r.steps} | ${percentile(s, 50)} | ${percentile(s, 90)} |`)
  }
  L.push('')

  const failReasons = [...failed, ...skipped].filter((r) => r.reason)
  L.push('## 失败/跳过原因摘要')
  L.push('')
  if (!failReasons.length) {
    L.push('- （无）')
  } else {
    for (const r of failReasons) L.push(`- **${r.name}**（${r.status === 'skipped' ? '跳过' : r.triage || '失败'}）: ${r.reason}`)
  }
  L.push('')

  L.push('## expect 验收明细')
  L.push('')
  for (const r of results) {
    if (!r.expects.length) continue
    L.push(`- **${r.name}**`)
    for (const e of r.expects) {
      L.push(`  - ${e.ok ? '✅' : '❌'} ${e.desc}${e.actual != null ? `（实际: ${String(e.actual).replace(/\n/g, ' ').slice(0, 80)}）` : ''}`)
    }
  }
  L.push('')
  return L.join('\n')
}

/** 报告落盘 reports/regression/<yyyyMMdd-HHmmss>.md，返回绝对路径 */
export function writeReport(results: CaseResult[], startedAt: number): string {
  const ts = new Date(startedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-` +
    `${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
  const dir = join(process.cwd(), 'reports', 'regression')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${stamp}.md`)
  writeFileSync(file, buildReportMarkdown(results, startedAt), 'utf-8')
  return file
}
