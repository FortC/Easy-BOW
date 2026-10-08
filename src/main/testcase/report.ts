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
  // 同目录产出 HTML 版（可直接浏览器打开/发同事；截图相对引用 shots/）
  try {
    writeFileSync(join(dir, 'report.html'), renderHtmlReport(run), 'utf-8')
  } catch {
    /* HTML 写失败不影响 MD 报告 */
  }
  // JUnit XML（CI 集成：Jenkins/GitLab CI 解析测试结果与失败明细）
  try {
    writeFileSync(join(dir, 'junit.xml'), renderJUnit(run), 'utf-8')
  } catch {
    /* XML 写失败不影响 MD 报告 */
  }
  return reportPath
}

/** JUnit XML 格式（steps → testcase；failed → failure；skipped → skipped） */
function renderJUnit(run: TestRunStatus): string {
  const esc = (s: unknown): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const dur = run.endedAt && run.startedAt ? (run.endedAt - run.startedAt) / 1000 : 0
  const failures = run.steps.filter((s) => s.status === 'failed').length
  const skipped = run.steps.filter((s) => s.status === 'skipped').length
  const cases = run.steps
    .map((s) => {
      const inner =
        s.status === 'failed'
          ? `\n      <failure message="${esc(s.error || '断言失败')}">${esc(s.assertions.filter((a) => !a.passed).map((a) => `${a.raw} → 实际: ${a.actual || ''}`).join(' | '))}</failure>`
          : s.status === 'skipped'
            ? '\n      <skipped/>'
            : ''
      return `    <testcase name="${esc(s.index + '. ' + s.title)}" classname="${esc(run.caseName)}">${inner}\n    </testcase>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${esc(run.caseName)}" tests="${run.steps.length}" failures="${failures}" skipped="${skipped}" time="${dur.toFixed(2)}">
${cases}
</testsuite>
`
}

/** HTML 版报告（独立文件、内联样式，截图相对路径引用同目录 shots/） */
function renderHtmlReport(run: TestRunStatus): string {
  const esc = (s: unknown): string =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const badge =
    run.state === 'passed'
      ? '<span class="b ok">✅ 通过</span>'
      : run.state === 'failed'
        ? '<span class="b bad">❌ 失败</span>'
        : `<span class="b warn">${run.state === 'stopped' ? '⏹️ 已停止' : '⚠️ 异常'}</span>`
  const dur = run.endedAt && run.startedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null
  const rows = run.steps
    .map((s) => {
      const mark = s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : '⏳'
      const asserts = s.assertions
        .map(
          (a) =>
            `<div class="a ${a.passed ? 'ok' : 'bad'}"><span>${a.passed ? '✓' : '✗'}</span><code>${esc(a.raw)}</code>${
              a.passed ? '' : `<em>实际: ${esc(a.actual || '(未取得)')}</em>`
            }</div>`
        )
        .join('')
      const shot = s.shotFile ? `<img src="${esc(s.shotFile)}" alt="失败截图" loading="lazy">` : ''
      return `<div class="step ${s.status}"><div class="h"><span>${mark}</span><b>${s.index}. ${esc(s.title)}</b><span class="m">${esc(
        s.error || ''
      )}</span></div>${asserts ? `<div class="as">${asserts}</div>` : ''}${shot}</div>`
    })
    .join('')
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>测试报告: ${esc(run.caseName)}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1f2329;background:#fafbfc}
h1{font-size:20px}.meta{font-size:13px;color:#646a73;margin:8px 0 16px;line-height:1.9}
.b{padding:2px 10px;border-radius:10px;font-size:13px}.b.ok{background:#e8f7ec;color:#2e9e44}.b.bad{background:#fdeeee;color:#d9393a}.b.warn{background:#fff7e8;color:#b26a00}
.step{border:1px solid #eceef1;border-radius:8px;padding:8px 12px;margin:6px 0;background:#fff}
.step.failed{border-color:#f2c1c1}.step.passed{border-color:#cdebd4}
.h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13.5px}.m{color:#d9393a;font-size:12px}
.as{margin-top:6px;padding-left:18px}.a{font-size:12.5px;margin:2px 0}.a em{color:#d9393a;font-style:normal;margin-left:6px}
code{background:#f4f5f7;padding:0 4px;border-radius:3px;font-size:12px}
img{max-width:100%;border:1px solid #e5e6eb;border-radius:6px;margin-top:8px}
</style></head><body>
<h1>测试报告: ${esc(run.caseName)} ${badge}</h1>
<div class="meta">
通过 ${run.passed}/${run.totalSteps} 步${run.envName ? ` · 环境: ${esc(run.envName)}` : ''}${run.groupName ? ` · 组: ${esc(run.groupName)}` : ''}${
    dur != null ? ` · 耗时 ${dur}s` : ''
  } · Token 输入 ${run.tokens?.input || 0} / 输出 ${run.tokens?.output || 0}<br>
开始: ${esc(new Date(run.startedAt || Date.now()).toLocaleString('zh-CN', { hour12: false }))}
</div>
${rows}
</body></html>`
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
