/**
 * 测试报告生成：TestRunStatus → Markdown 报告（含失败步骤截图落盘）。
 * 目录结构：userData/reports/<runId>/report.md + shots/step-N.jpg
 */
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TestCase, TestRunStatus } from '@shared/types'

export function reportsRoot(): string {
  return join(app.getPath('userData'), 'reports')
}

const verdictText = (s: TestRunStatus['state']): string =>
  s === 'passed' ? '✅ 通过' : s === 'failed' ? '❌ 失败' : s === 'stopped' ? '⏹️ 已停止' : '⚠️ 异常'

/**
 * 写报告并返回 report.md 绝对路径。shots 为「步骤序号 → jpeg dataURL」，
 * 落盘为 shots/step-N.jpg，报告内相对引用。
 */
export function writeTestReport(run: TestRunStatus, tc: TestCase, shots: Map<number, string>): string {
  const runId = new Date(run.startedAt || Date.now())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15) // yyyyMMdd-HHmmss
  const dir = join(reportsRoot(), `${runId}-${sanitize(run.caseName)}`)
  const shotsDir = join(dir, 'shots')
  mkdirSync(shotsDir, { recursive: true })

  for (const [stepIdx, dataUrl] of shots) {
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    if (!b64) continue
    try {
      writeFileSync(join(shotsDir, `step-${stepIdx}.jpg`), Buffer.from(b64, 'base64'))
      const st = run.steps.find((s) => s.index === stepIdx)
      if (st) st.shotFile = `shots/step-${stepIdx}.jpg`
    } catch {
      /* 截图写失败不阻断报告 */
    }
  }

  const dur = run.endedAt && run.startedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null
  const lines: string[] = []
  lines.push(`# 测试报告: ${run.caseName}`)
  lines.push('')
  lines.push(`- **结果**: ${verdictText(run.state)}（通过 ${run.passed}/${run.totalSteps} 步）`)
  if (run.envName) lines.push(`- **环境**: ${run.envName}`)
  lines.push(`- **开始**: ${new Date(run.startedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`)
  if (dur != null) lines.push(`- **耗时**: ${dur}s`)
  lines.push(`- **Token**: 输入 ${run.tokens.input} / 输出 ${run.tokens.output}`)
  lines.push('')
  lines.push(`## 步骤结果`)
  lines.push('')
  lines.push(`| # | 步骤 | 状态 | 模型步数 | 断言 | 失败原因 |`)
  lines.push(`|---|---|---|---|---|---|`)
  for (const s of run.steps) {
    const mark = s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'running' ? '⏳' : s.status === 'skipped' ? '⏭️' : '⏳'
    const okA = s.assertions.filter((a) => a.passed).length
    lines.push(
      `| ${s.index} | ${s.title.replace(/\|/g, '/')} | ${mark} | ${s.modelSteps} | ${s.assertions.length ? `${okA}/${s.assertions.length}` : '-'} | ${(s.error || '').replace(/\|/g, '/').slice(0, 80)} |`
    )
  }
  lines.push('')
  const failed = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped')
  if (failed.length) {
    lines.push(`## 失败详情`)
    for (const s of failed) {
      lines.push('')
      lines.push(`### ${s.index}. ${s.title} — ${s.error || '未执行'}`)
      for (const a of s.assertions) {
        lines.push(`- ${a.passed ? '✅' : '❌'} \`${a.raw}\`${a.passed ? '' : ` — 实际: ${a.actual || '(未取得)'}`}`)
      }
      if (s.shotFile) lines.push(`- 失败截图: ![${s.title}](${s.shotFile})`)
      const script = tc.steps[s.index - 1]
      if (script) lines.push(`- 脚本操作: ${script.action}`)
    }
    lines.push('')
  }
  lines.push(`## 用例脚本`)
  lines.push('')
  lines.push('```md')
  lines.push(renderCaseMd(tc))
  lines.push('```')
  const reportPath = join(dir, 'report.md')
  writeFileSync(reportPath, lines.join('\n'), 'utf-8')
  return reportPath
}

/** 用例回显（与 parser 输入规范一致的 MD） */
export function renderCaseMd(tc: TestCase): string {
  const out: string[] = [`# TESTCASE: ${tc.name}`, '']
  const varKeys = Object.keys(tc.vars)
  if (varKeys.length) {
    out.push('## 测试数据', '', '| 变量 | 值 |', '|---|---|')
    for (const k of varKeys) out.push(`| ${k} | ${tc.vars[k]} |`)
    out.push('')
  }
  out.push('## 步骤', '')
  for (const s of tc.steps) {
    out.push(`### ${s.title.replace(/^清理: /, (m) => m)}`)
    out.push(`- 操作: ${s.action}`)
    for (const a of s.assertions) out.push(`- 预期: ${a.raw}`)
    if (s.dialog) out.push(`- 弹窗: ${s.dialog === 'accept' ? '确认' : '取消'}`)
    out.push('')
  }
  return out.join('\n')
}

function sanitize(name: string): string {
  return (name || 'testcase').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}
