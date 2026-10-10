#!/usr/bin/env node
/**
 * EasyBow W12 失败看板 —— telemetry trace 周报生成器（纯 Node ESM、零依赖、Node ≥ 18）。
 *
 * 数据源：userData/traces/{yyyyMMdd}/{taskId}.jsonl，一行一个 JSON 事件
 *   { ts, taskId, step, type, data }，事件类型见 src/main/telemetry.ts：
 *   task_start / task_end / step_timing / llm_call / action / failure /
 *   circuit_break / expert_retry / replan / action_verify / friction / human 等。
 *
 * 用法：
 *   node scripts/analyze-traces.mjs [--dir <traces目录>] [--days N] [--help]
 *   npm run analyze-traces -- --dir D:\tmp\traces --days 14
 *
 * 参数：
 *   --dir <path>  traces 目录。默认 process.env.EASYBOW_TRACES，否则按平台取
 *                 Electron userData/traces（Windows: %APPDATA%/easybow/traces）。
 *   --days N      只统计最近 N 天（含今天，按目录名 yyyyMMdd 过滤），默认 7；N<=0 表示全部。
 *   --help        打印帮助。
 *
 * 输出：周报 Markdown 打印到 stdout，同时写 reports/weekly-<YYYY-MM-DD>.md（相对当前目录）。
 * 目录不存在 / 窗口内无数据：打印友好提示，退出码 0。
 *
 * 合规（硬要求）：所有输出文本字段经 redact() 脱敏后才进报告——
 *   手机号 / ≥10 位长数字（订单号等）/ 邮箱 / 账号密码 / URL 密钥 query 参数值 → 打码。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ----------------------------- 脱敏（纯函数，硬要求） ----------------------------- */

/**
 * 输出前脱敏。所有写入报告的自由文本字段都必须过这里。
 * 规则（顺序敏感，先 URL 后长数字，避免把已打码文本二次截断）：
 *   1. URL query 密钥参数（access_token/token/key/sign/sessionid/…）值 → ***
 *   2. 邮箱 → ***
 *   3. 账号/用户名/密码类（账号[:：=]值）值 → ***
 *   4. 手机号 1[3-9]\d{9} → ***
 *   5. ≥10 位连续数字（订单号等）→ ***
 */
function redact(s) {
  if (typeof s !== 'string') return s
  return s
    .replace(
      /([?&;](?:access_token|token|key|sign|sessionid|session_id|sid|auth|password|pwd|secret|api_key|apikey|signature)=)[^&\s"'#，。；、]*/gi,
      '$1***'
    )
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '***')
    .replace(
      /((?:账号名|账号|帐号|用户名|密码|account|username|login|passwd|password)\s*[:：=]\s*)("[^"]*"|[^\s，。；、,;]*)/gi,
      '$1***'
    )
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '***')
    .replace(/(?<!\d)\d{10,}(?!\d)/g, '***')
}
export { redact }

/* ----------------------------- CLI ----------------------------- */

function defaultTracesDir() {
  if (process.env.EASYBOW_TRACES) return resolve(process.env.EASYBOW_TRACES)
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'easybow', 'traces')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'easybow', 'traces')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'easybow', 'traces')
}

function parseArgs(argv) {
  const opts = { dir: null, days: 7, help: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    let inline = null
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 2) {
      inline = a.slice(eq + 1)
      a = a.slice(0, eq)
    }
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dir') {
      const v = inline ?? argv[++i]
      if (v == null) throw new Error('--dir 缺少参数值')
      opts.dir = resolve(v)
    } else if (a === '--days') {
      const v = inline ?? argv[++i]
      const n = Number(v)
      if (v == null || !Number.isFinite(n)) throw new Error('--days 需要一个数字参数')
      opts.days = Math.trunc(n)
    } else {
      throw new Error(`未知参数：${a}（--help 查看用法）`)
    }
  }
  return opts
}

const HELP = `EasyBow 失败看板周报生成器（W12）

用法：
  node scripts/analyze-traces.mjs [选项]
  npm run analyze-traces -- [选项]

选项：
  --dir <path>   traces 目录（默认 \$EASYBOW_TRACES 或 %APPDATA%/easybow/traces）
  --days N       只统计最近 N 天（含今天），默认 7；N<=0 表示全部
  --help, -h     显示本帮助

输出：
  周报 Markdown 打印到 stdout，并写入 reports/weekly-<YYYY-MM-DD>.md（当前目录下）。
  所有文本字段输出前自动脱敏（手机号 / 长数字单号 / 邮箱 / 账号密码 / URL 密钥参数）。`

/* ----------------------------- 工具 ----------------------------- */

const SUCCESS_STATES = new Set(['success', 'done', 'completed'])
const TRIAGES = ['agent', 'infra', 'product']

/** step_timing 分段：[桶键, data 字段, 报告标签] */
const SEG_FIELDS = [
  ['extract', 'extractMs', 'extract 元素提取'],
  ['ax', 'axMs', 'ax AX Tree'],
  ['llm', 'llmMs', 'llm 模型调用'],
  ['act', 'actMs', 'act 动作执行'],
  ['settle', 'settleMs', 'settle 批后等待'],
  ['shot', 'shotMs', 'shot 时间线截图']
]

function pct(sortedVals, p) {
  if (!sortedVals.length) return null
  const idx = Math.min(sortedVals.length - 1, Math.max(0, Math.ceil((p / 100) * sortedVals.length) - 1))
  return sortedVals[idx]
}

function p50p90(vals) {
  const s = [...vals].sort((a, b) => a - b)
  return [pct(s, 50), pct(s, 90), s.length]
}

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US')
const fmtMs = (v) => (v == null ? '—' : `${Math.round(v)}`)
const fmtRate = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
const fmtMean = (a, b) => (b ? (a / b).toFixed(2) : '—')

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 'yyyyMMdd' → 'yyyy-MM-dd'（非日期形目录原样返回） */
function formatDayKey(key) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(key)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : key
}

function dayKeyToDate(key) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function todayLabel(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 最近 N 天窗口（含今天）；非 yyyyMMdd 目录不过滤；N<=0 全收 */
function withinWindow(key, days) {
  if (days <= 0) return true
  const d = dayKeyToDate(key)
  if (!d) return true
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return d >= start
}

/** circuit_break 站点：data.host 或 data.url 的 host */
function hostOf(data) {
  if (typeof data?.host === 'string' && data.host) return data.host
  const u = data?.url
  if (typeof u === 'string' && u) {
    try {
      return new URL(u).host || '(unknown)'
    } catch {
      return u.split('/')[0] || '(unknown)'
    }
  }
  return '(unknown)'
}

function mdTable(headers, rows) {
  const lines = []
  lines.push(`| ${headers.join(' | ')} |`)
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`)
  return lines.join('\n')
}

/* ----------------------------- 扫描与聚合 ----------------------------- */

function loadFile(path) {
  const events = []
  let bad = 0
  let text = ''
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return { events, bad: 1 }
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const ev = JSON.parse(t)
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') events.push(ev)
      else bad++
    } catch {
      bad++
    }
  }
  return { events, bad }
}

function summarizeTask(fileName, events) {
  const t = {
    id: basename(fileName, '.jsonl'),
    desc: '',
    end: null,
    state: '',
    success: false,
    triage: 'agent', // 失败三分类：成功任务最终置 null
    failureEvents: 0,
    parseFails: 0,
    circuitHosts: new Map(), // host -> 次数
    expertRetries: 0,
    replans: 0,
    forceL2: 0,
    llmCalls: 0,
    llmIn: 0,
    llmOut: 0,
    plannerCalls: 0,
    plannerIn: 0,
    plannerOut: 0,
    stepsWithLlm: new Set(),
    stepsWithAction: new Set(),
    maxStep: 0
  }
  for (const ev of events) {
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
    if (typeof ev.step === 'number' && ev.step > t.maxStep) t.maxStep = ev.step
    switch (ev.type) {
      case 'task_start':
        if (!t.desc && typeof d.task === 'string') t.desc = d.task
        break
      case 'task_end': {
        t.end = {
          state: String(d.state ?? ''),
          steps: Number(d.steps) || 0,
          tokensIn: Number(d.tokensIn) || 0,
          tokensOut: Number(d.tokensOut) || 0,
          triage: typeof d.triage === 'string' ? d.triage : '',
          triageReason: typeof d.triageReason === 'string' ? d.triageReason : ''
        }
        break
      }
      case 'failure': {
        t.failureEvents++
        const kind = String(d.kind ?? '')
        if (/parse|解析/i.test(kind) || /解析|json/i.test(String(d.error ?? ''))) t.parseFails++
        break
      }
      case 'circuit_break': {
        const h = hostOf(d)
        t.circuitHosts.set(h, (t.circuitHosts.get(h) || 0) + 1)
        break
      }
      case 'expert_retry':
        t.expertRetries++
        break
      case 'replan':
        t.replans++
        if (d.forceL2 === true) t.forceL2++
        break
      case 'llm_call': {
        const input = Number(d.input) || 0
        const output = Number(d.output) || 0
        if (d.planner === true) {
          t.plannerCalls++
          t.plannerIn += input
          t.plannerOut += output
        } else {
          t.llmCalls++
          t.llmIn += input
          t.llmOut += output
        }
        if (typeof ev.step === 'number') t.stepsWithLlm.add(ev.step)
        break
      }
      case 'action':
        if (typeof ev.step === 'number') t.stepsWithAction.add(ev.step)
        break
      default:
        break
    }
  }
  // 任务成败与三分类（口径：triage 缺省按 state 推断，success=成功，其余=agent）
  if (t.end) {
    t.state = t.end.state || '(空 state)'
    t.success = SUCCESS_STATES.has(t.state.toLowerCase())
    if (t.success) t.triage = null
    else t.triage = TRIAGES.includes(t.end.triage) ? t.end.triage : 'agent'
  } else {
    t.state = '(无 task_end)'
    t.success = false
    t.triage = 'agent'
  }
  return t
}

function analyze(dir, days) {
  const stats = {
    dir,
    days,
    dayKeys: [],
    dayBuckets: new Map(),
    typeCounts: new Map(),
    fileCount: 0,
    eventCount: 0,
    badLines: 0,
    taskCount: 0
  }
  let dayNames
  try {
    dayNames = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((k) => withinWindow(k, days))
      .sort()
  } catch {
    return stats
  }

  for (const key of dayNames) {
    const dayDir = join(dir, key)
    let files = []
    try {
      files = readdirSync(dayDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort()
    } catch {
      continue
    }
    if (!files.length) continue

    const bucket = {
      key,
      label: formatDayKey(key),
      tasks: [],
      timingTotals: [],
      segs: { extract: [], ax: [], llm: [], act: [], settle: [], shot: [] },
      badLines: 0
    }

    for (const f of files) {
      const { events, bad } = loadFile(join(dayDir, f))
      stats.fileCount++
      stats.badLines += bad
      bucket.badLines += bad
      stats.eventCount += events.length
      for (const ev of events) {
        stats.typeCounts.set(ev.type, (stats.typeCounts.get(ev.type) || 0) + 1)
        if (ev.type === 'step_timing') {
          const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
          let total = 0
          let any = false
          for (const [bucketKey, field] of SEG_FIELDS) {
            const v = Number(d[field])
            if (Number.isFinite(v)) {
              bucket.segs[bucketKey].push(v)
              total += v
              any = true
            }
          }
          if (any) bucket.timingTotals.push(total)
        }
      }
      const task = summarizeTask(f, events)
      task.dayKey = key
      bucket.tasks.push(task)
    }
    stats.taskCount += bucket.tasks.length
    stats.dayBuckets.set(key, bucket)
    stats.dayKeys.push(key)
  }
  return stats
}

/* ----------------------------- 报告渲染 ----------------------------- */

function renderReport(stats, windowLabel) {
  const L = []
  const allTasks = []
  for (const key of stats.dayKeys) allTasks.push(...stats.dayBuckets.get(key).tasks)

  const totalTasks = allTasks.length
  const successTasks = allTasks.filter((t) => t.success).length
  const failedTasks = totalTasks - successTasks

  L.push(`# EasyBow 失败看板周报（${windowLabel}）`)
  L.push('')
  L.push(
    `> 数据源：\`${redact(stats.dir)}\` · 任务 ${totalTasks} 个 · 事件 ${fmtInt(stats.eventCount)} 条 · 坏行 ${fmtInt(stats.badLines)} 条（已跳过）· 生成于 ${todayLabel()}`
  )
  L.push('')

  /* 1. 成功率趋势 */
  L.push('## 1. 成功率趋势（按天）')
  L.push('')
  const trendRows = []
  const triageRows = []
  for (const key of stats.dayKeys) {
    const b = stats.dayBuckets.get(key)
    const ok = b.tasks.filter((t) => t.success).length
    const total = b.tasks.length
    trendRows.push([b.label, fmtInt(total), fmtInt(ok), fmtInt(total - ok), fmtRate(ok, total)])
    triageRows.push([
      b.label,
      fmtInt(b.tasks.filter((t) => t.triage === 'agent').length),
      fmtInt(b.tasks.filter((t) => t.triage === 'infra').length),
      fmtInt(b.tasks.filter((t) => t.triage === 'product').length)
    ])
  }
  trendRows.push(['**合计**', `**${fmtInt(totalTasks)}**`, `**${fmtInt(successTasks)}**`, `**${fmtInt(failedTasks)}**`, `**${fmtRate(successTasks, totalTasks)}**`])
  L.push(mdTable(['日期', '任务数', '成功', '失败', '成功率'], trendRows))
  L.push('')
  L.push('失败三分类分布（triage：agent 失败计入成功率 / infra 环境失败单列 / product 产品 bug）：')
  L.push('')
  triageRows.push([
    '**合计**',
    `**${fmtInt(allTasks.filter((t) => t.triage === 'agent').length)}**`,
    `**${fmtInt(allTasks.filter((t) => t.triage === 'infra').length)}**`,
    `**${fmtInt(allTasks.filter((t) => t.triage === 'product').length)}**`
  ])
  L.push(mdTable(['日期', 'agent', 'infra', 'product'], triageRows))
  L.push('')
  L.push('> 口径：task_end.triage 缺省按 state 推断——state=success 计成功，其余按 agent 计；无 task_end 的任务按失败 agent 计。')
  L.push('')

  /* 2. 步耗时 P50/P90 */
  L.push('## 2. 步耗时 P50/P90（step_timing，毫秒）')
  L.push('')
  const timingRows = []
  const allTotals = []
  const allSegs = { extract: [], ax: [], llm: [], act: [], settle: [], shot: [] }
  for (const key of stats.dayKeys) {
    const b = stats.dayBuckets.get(key)
    allTotals.push(...b.timingTotals)
    for (const [k] of SEG_FIELDS) allSegs[k].push(...b.segs[k])
    const [p50, p90, n] = p50p90(b.timingTotals)
    timingRows.push([b.label, fmtInt(n), fmtMs(p50), fmtMs(p90)])
  }
  {
    const [p50, p90, n] = p50p90(allTotals)
    timingRows.push(['**全窗口**', `**${fmtInt(n)}**`, `**${fmtMs(p50)}**`, `**${fmtMs(p90)}**`])
  }
  L.push(mdTable(['日期', '步样本', '总步耗时 P50', '总步耗时 P90'], timingRows))
  L.push('')
  L.push('分段 P50/P90（全窗口）：')
  L.push('')
  const segRows = []
  for (const [k, , label] of SEG_FIELDS) {
    const [p50, p90, n] = p50p90(allSegs[k])
    segRows.push([label, fmtInt(n), fmtMs(p50), fmtMs(p90)])
  }
  {
    const [p50, p90, n] = p50p90(allTotals)
    segRows.push([`**总步耗时（各段之和）**`, `**${fmtInt(n)}**`, `**${fmtMs(p50)}**`, `**${fmtMs(p90)}**`])
  }
  L.push(mdTable(['分段', '样本数', 'P50', 'P90'], segRows))
  L.push('')
  L.push('> 口径：总步耗时 = extractMs+axMs+llmMs+actMs+settleMs+shotMs 之和（缺段按 0）；P50/P90 取最近秩（nearest-rank）。')
  L.push('')

  /* 3. 熔断率 */
  L.push('## 3. 熔断率（circuit_break）')
  L.push('')
  const siteMap = new Map() // host -> { count, tasks:Set }
  let breakTotal = 0
  for (const t of allTasks) {
    for (const [host, n] of t.circuitHosts) {
      const s = siteMap.get(host) || { count: 0, tasks: new Set() }
      s.count += n
      s.tasks.add(t.id)
      siteMap.set(host, s)
      breakTotal += n
    }
  }
  if (breakTotal === 0) {
    L.push('窗口内无熔断事件。')
  } else {
    const rows = [...siteMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([host, s]) => [redact(host), fmtInt(s.count), fmtInt(s.tasks.size), fmtRate(s.count, totalTasks)])
    rows.push(['**合计**', `**${fmtInt(breakTotal)}**`, `**${fmtInt(new Set(allTasks.filter((t) => t.circuitHosts.size).map((t) => t.id)).size)}**`, `**${fmtRate(breakTotal, totalTasks)}**`])
    L.push(mdTable(['站点', '熔断次数', '涉及任务数', '熔断率（次数/任务数）'], rows))
  }
  L.push('')

  /* 4. 专家重试 */
  L.push('## 4. 专家重试（expert_retry）')
  L.push('')
  const retryTotal = allTasks.reduce((s, t) => s + t.expertRetries, 0)
  const retryTasks = allTasks.filter((t) => t.expertRetries > 0).length
  L.push(`共 **${fmtInt(retryTotal)}** 次，均值 **${fmtMean(retryTotal, totalTasks)}** 次/任务（涉及 ${fmtInt(retryTasks)} 个任务）。`)
  L.push('')

  /* 5. 重规划 */
  L.push('## 5. 重规划（replan）')
  L.push('')
  const replanTotal = allTasks.reduce((s, t) => s + t.replans, 0)
  const replanTasks = allTasks.filter((t) => t.replans > 0).length
  const forceL2Total = allTasks.reduce((s, t) => s + t.forceL2, 0)
  const forceL2Tasks = allTasks.filter((t) => t.forceL2 > 0).length
  L.push(
    `重规划 **${fmtInt(replanTotal)}** 次（涉及 ${fmtInt(replanTasks)} 个任务，均值 ${fmtMean(replanTotal, totalTasks)} 次/任务）；其中「重规划任务 done 强制 L2」（replan.forceL2）**${fmtInt(forceL2Total)}** 次（涉及 ${fmtInt(forceL2Tasks)} 个任务）。`
  )
  L.push('')

  /* 6. Token */
  L.push('## 6. Token 消耗')
  L.push('')
  const sum = (f) => allTasks.reduce((s, t) => s + (t[f] || 0), 0)
  const endIn = allTasks.reduce((s, t) => s + (t.end?.tokensIn || 0), 0)
  const endOut = allTasks.reduce((s, t) => s + (t.end?.tokensOut || 0), 0)
  const plannerIn = sum('plannerIn')
  const plannerOut = sum('plannerOut')
  const otherIn = sum('llmIn')
  const otherOut = sum('llmOut')
  const tokRows = [
    ['任务累计（task_end.tokensIn/tokensOut）', fmtInt(totalTasks), fmtInt(endIn), fmtInt(endOut), fmtInt(endIn + endOut)],
    ['其中 planner 模型（llm_call.planner=true）', fmtInt(sum('plannerCalls')), fmtInt(plannerIn), fmtInt(plannerOut), fmtInt(plannerIn + plannerOut)],
    ['其他模型调用（llm_call 非 planner）', fmtInt(sum('llmCalls')), fmtInt(otherIn), fmtInt(otherOut), fmtInt(otherIn + otherOut)]
  ]
  L.push(mdTable(['指标', '次数', 'input', 'output', '合计'], tokRows))
  L.push('')

  /* 7. 解析失败步占比 */
  L.push('## 7. 解析失败步占比（近似口径）')
  L.push('')
  const parseEvents = allTasks.reduce((s, t) => s + t.parseFails, 0)
  const errTasks = allTasks.filter((t) => !t.success && /error/i.test(t.state)).length
  const errTasksNoParse = allTasks.filter((t) => !t.success && /error/i.test(t.state) && t.parseFails === 0).length
  const parseFailStepsApprox = parseEvents + errTasksNoParse
  const totalSteps = allTasks.reduce((s, t) => s + (t.end?.steps || t.maxStep || 0), 0)
  const noActionSteps = allTasks.reduce((s, t) => {
    let n = 0
    for (const st of t.stepsWithLlm) if (!t.stepsWithAction.has(st)) n++
    return n
  }, 0)
  L.push(
    `解析失败步 ≈ **${fmtInt(parseFailStepsApprox)}** / 总步数 **${fmtInt(totalSteps)}** → 占比 **${fmtRate(parseFailStepsApprox, totalSteps)}**`
  )
  L.push('')
  L.push(
    `- 构成：failure 事件 kind=parse 类 ${fmtInt(parseEvents)} 步 + task_end.state=error 且无 parse 事件的任务 ${fmtInt(errTasksNoParse)} 个（每任务按 1 个解析失败步计，state=error 任务共 ${fmtInt(errTasks)} 个）`
  )
  L.push(
    `- 参考：llm_call 后该步无 action 事件的步数 ${fmtInt(noActionSteps)}（含 done 步，偏高估，仅参考不计入占比）`
  )
  L.push(
    '- 口径：trace 中没有专门的 parse 失败事件，故按「task_end.state=error 与 failure 事件」近似；总步数 = Σ task_end.steps（缺 steps 时取事件最大 step）。'
  )
  L.push('')

  /* 8. 失败任务明细（脱敏） */
  const failedList = allTasks.filter((t) => !t.success)
  L.push('## 8. 失败任务明细（文本已脱敏）')
  L.push('')
  if (!failedList.length) {
    L.push('窗口内无失败任务。')
  } else {
    const shown = failedList.slice(0, 50)
    const rows = shown.map((t) => {
      const b = stats.dayBuckets.get(t.dayKey)
      return [
        b ? b.label : '',
        t.id,
        redact(t.state),
        t.triage || '—',
        redact(t.end?.triageReason || '') || '—',
        fmtInt(t.end?.steps || t.maxStep || 0)
      ]
    })
    L.push(mdTable(['日期', '任务', '状态', '三分类', '原因（triageReason）', '步数'], rows))
    if (failedList.length > shown.length) L.push(`\n> 共 ${fmtInt(failedList.length)} 条失败任务，仅显示前 50 条。`)
  }
  L.push('')

  /* 附录：口径与事件计数 */
  L.push('## 附录：数据口径')
  L.push('')
  L.push(`- 扫描范围：\`${redact(stats.dir)}\` 下 \`*/*.jsonl\`（目录名 yyyyMMdd），${stats.days > 0 ? `最近 ${stats.days} 天` : '全部天数'}，任务文件 ${fmtInt(stats.fileCount)} 个。`)
  L.push(`- 坏行（JSON 解析失败/缺 type 字段）共 ${fmtInt(stats.badLines)} 条，已跳过不计入统计。`)
  L.push('- 成功 = task_end.state ∈ {success, done, completed}；失败三分类缺省按 state 推断（见第 1 节口径）。')
  L.push('- 熔断率 = circuit_break 事件数 / 窗口任务数，站点取 data.host 或 data.url 的 host。')
  L.push('- 解析失败步占比为近似口径（见第 7 节），无专门 parse 事件时仅供趋势参考。')
  L.push('- 脱敏规则：手机号 1[3-9]\\d{9}、≥10 位连续数字（订单号等）、邮箱、账号/用户名/密码值、URL 密钥 query 参数值（access_token/token/key/sign/sessionid 等）→ \`***\`。')
  L.push('')
  const typeRows = [...stats.typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, fmtInt(v)])
  if (typeRows.length) {
    L.push('事件计数：')
    L.push('')
    L.push(mdTable(['事件类型', '条数'], typeRows))
    L.push('')
  }

  /* 末尾：样例数据脱敏自检（T12 验收项） */
  L.push('## 样例数据脱敏自检')
  L.push('')
  const samples = [
    '任务重试失败：拨打 13812345678 联系运营，页面报错「提交失败」',
    '订单 202610101234567 提交超时，卡在确认页，重试 3 次仍失败',
    'GET https://erp.example.com/api/order/list?access_token=abc123secret&sign=9f8e7d6a&order_id=88 返回 401',
    '登录账号=erp_zhangsan 密码=Passw0rd!，异常通知发到 zhangsan@corp-example.com'
  ]
  const secrets = [
    '13812345678',
    '202610101234567',
    'abc123secret',
    '9f8e7d6a',
    'erp_zhangsan',
    'Passw0rd',
    'zhangsan@corp-example.com'
  ]
  const rows = []
  let leaked = []
  for (const s of samples) {
    const r = redact(s)
    rows.push([s, r])
    for (const sec of secrets) if (r.includes(sec)) leaked.push(sec)
  }
  L.push(mdTable(['原文（虚构样例）', 'redact() 后'], rows))
  L.push('')
  if (leaked.length === 0) {
    L.push(`**自检结论：${secrets.length} 处敏感串全部被打码 —— 通过**`)
  } else {
    L.push(`**自检结论：未通过 —— 仍有敏感串残留：${[...new Set(leaked)].join(', ')}**`)
  }
  L.push('')
  return L.join('\n')
}

/* ----------------------------- 主流程 ----------------------------- */

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`参数错误：${e.message}`)
    process.exit(1)
  }
  if (opts.help) {
    console.log(HELP)
    return
  }

  const dir = opts.dir || defaultTracesDir()
  if (!existsSync(dir)) {
    console.log(`未找到 traces 目录：${dir}`)
    console.log('提示：确认 EasyBow 已运行过且开启了埋点（设置 → telemetry），或用 --dir <path> / 环境变量 EASYBOW_TRACES 指定目录。')
    console.log('本次未生成报告（退出码 0）。')
    return
  }

  const stats = analyze(dir, opts.days)
  if (!stats.taskCount) {
    console.log(`traces 目录存在但${stats.days > 0 ? `最近 ${stats.days} 天内` : ''}没有可统计的 trace 文件：${dir}`)
    console.log('提示：放宽 --days（如 --days 0 看全部）或确认任务已产生埋点数据。')
    console.log('本次未生成报告（退出码 0）。')
    return
  }

  const labels = stats.dayKeys.map((k) => formatDayKey(k))
  const windowLabel = `${labels[0]} ~ ${labels[labels.length - 1]}${stats.days > 0 ? `，最近 ${stats.days} 天` : '，全部天数'}`
  const md = renderReport(stats, windowLabel)

  console.log(md)

  try {
    const outDir = resolve(process.cwd(), 'reports')
    mkdirSync(outDir, { recursive: true })
    const outFile = join(outDir, `weekly-${todayLabel()}.md`)
    writeFileSync(outFile, md, 'utf-8')
    console.error(`报告已写入：${outFile}`)
  } catch (e) {
    console.error(`报告写盘失败（stdout 输出不受影响）：${e.message}`)
  }
}

// 直接执行时才跑主流程；被 import（如 redact 自测）时不产生副作用
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href.toLowerCase() : ''
if (entry && import.meta.url.toLowerCase() === entry) main()
