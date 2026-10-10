/**
 * 回归模式（--regression）：顺序跑任务型用例（自然语言任务交 AgentRunner）+ 末尾 expect 验收，
 * 失败按 agent/infra/product 三分类出 Markdown 报告（T1 骨架 + T11 fixture 用例）。
 * 运行：npm run regression（构建由 package.json 脚本负责）。
 * 用例 1 = 本地 fixture（同名按钮列表）；用例 2/3 = cases.json 真实站点占位（未配置标 skipped）。
 */
import { app, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { createServer } from 'http'
import { join } from 'path'
import { TabManager } from '../tabs'
import { Executor } from '../executor'
import { AgentRunner } from '../agent/runner'
import { getSettings, saveSettings, settingsReloadAfterReady } from '../settings'
import type { MainEvent, Settings, StepRecord } from '@shared/types'
import type { CaseExpect, CaseResult, ConfigCase, ExpectResult, RegressionCase } from './types'
import { classifyFailure } from './triage'
import { writeReport } from './report'

/** 单用例超时（毫秒）：任务跑不完按失败收尾并停任务 */
const CASE_TIMEOUT_MS = 180_000

/** telemetry trace 一行事件（仅取报表要用的字段） */
interface TraceLine {
  ts: number
  type: string
  data: Record<string, unknown>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** fixtures 目录：开发态仓库内；打包后取 extraResources 的 fixtures */
function fixturesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'fixtures') : join(__dirname, '../../resources/fixtures')
}

/** 临时起本地 http 服务托管 fixtures（随机端口）。
 *  同源 iframe 嵌套、fetch 打自身都依赖 http；file:// 下同源策略不稳。 */
function startFixtureServer(rootDir: string): Promise<{ baseUrl: string; close: () => void }> {
  const srv = createServer((req, res) => {
    const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+|\/+$/g, '') || 'index.html'
    try {
      const data = readFileSync(join(rootDir, rel))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => srv.close() })
    })
  })
}

/** 回归跑在临时 userData：AI 配置不随正式 profile 带过来。
 *  ① 环境变量优先（CI 场景）② 其次复用正式 profile 的 settings.json（本机日常跑）。 */
function seedSettings(): void {
  const patch: Partial<Settings> = {}
  if (process.env.EASYBOW_API_KEY) patch.apiKey = process.env.EASYBOW_API_KEY
  if (process.env.EASYBOW_BASE_URL) patch.baseURL = process.env.EASYBOW_BASE_URL
  if (process.env.EASYBOW_MODEL) patch.model = process.env.EASYBOW_MODEL
  const prov = process.env.EASYBOW_PROVIDER
  if (prov === 'openai' || prov === 'anthropic') patch.provider = prov
  if (Object.keys(patch).length) saveSettings(patch)
  if (!getSettings().apiKey) {
    for (const name of ['easybow', 'EasyBow']) {
      const src = join(app.getPath('appData'), name, 'settings.json')
      if (existsSync(src)) {
        try {
          copyFileSync(src, join(app.getPath('userData'), 'settings.json'))
        } catch {}
        break
      }
    }
    settingsReloadAfterReady()
  }
}

/** telemetry trace 目录（与 telemetry.ts 落盘路径一致） */
function traceDir(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return join(app.getPath('userData'), 'traces', day)
}

function listTraceFiles(): Set<string> {
  try {
    return new Set(readdirSync(traceDir()))
  } catch {
    return new Set()
  }
}

function readTraceEvents(files: string[]): TraceLine[] {
  const out: TraceLine[] = []
  for (const f of files) {
    try {
      for (const line of readFileSync(join(traceDir(), f), 'utf-8').split('\n')) {
        if (!line.trim()) continue
        const ev = JSON.parse(line)
        if (ev && typeof ev.type === 'string') out.push(ev as TraceLine)
      }
    } catch {}
  }
  return out
}

/** 每步耗时：优先 telemetry step_timing 分段计时（T0）；
 *  未采集时回退步记录（timings 求和；再缺则用相邻步时间差估算）。 */
function stepDurations(events: TraceLine[], recs: StepRecord[], endTs: number): number[] {
  const parts = ['extractMs', 'axMs', 'llmMs', 'actMs', 'settleMs', 'shotMs'] as const
  const fromTrace: number[] = []
  for (const ev of events) {
    if (ev.type !== 'step_timing') continue
    const d = ev.data || {}
    const total = typeof d.totalMs === 'number' ? d.totalMs : parts.reduce((s, k) => s + (typeof d[k] === 'number' ? (d[k] as number) : 0), 0)
    if (total > 0) fromTrace.push(total)
  }
  if (fromTrace.length) return fromTrace
  const out: number[] = []
  for (let i = 0; i < recs.length; i++) {
    const t = recs[i].timings
    const sum = t ? parts.reduce((s, k) => s + (typeof t[k] === 'number' ? (t[k] as number) : 0), 0) : 0
    if (sum > 0) {
      out.push(sum)
      continue
    }
    const end = i + 1 < recs.length ? recs[i + 1].ts : endTs
    const d = end - recs[i].ts
    if (d > 0 && d < 600_000) out.push(d)
  }
  return out
}

/** 页面内一次性执行全部 expect 验收（返回每条 ok + 实际值摘要） */
const EXPECT_FN = String((exps: Array<{ kind: string; value?: string; selector?: string; negate?: boolean }>) => {
  return exps.map((e) => {
    let ok = false
    let actual = ''
    try {
      const bodyText = (document.body && document.body.innerText) || ''
      if (e.kind === 'text_visible') {
        actual = bodyText.slice(0, 120)
        ok = bodyText.indexOf(e.value || '') >= 0
      } else if (e.kind === 'url_contains') {
        actual = location.href
        ok = location.href.indexOf(e.value || '') >= 0
      } else if (e.kind === 'selector_exists') {
        ok = !!document.querySelector(e.selector || '')
        actual = ok ? '存在' : '不存在'
      } else if (e.kind === 'selector_text') {
        const el = document.querySelector(e.selector || '')
        actual = el ? String(el.textContent || '').trim().slice(0, 120) : '(元素不存在)'
        ok = !!el && String(el.textContent || '').indexOf(e.value || '') >= 0
      } else if (e.kind === 'selector_value') {
        const el = document.querySelector(e.selector || '') as { value?: unknown } | null
        actual = el && el.value != null ? String(el.value).slice(0, 120) : '(元素不存在)'
        ok = !!el && String(el.value || '').indexOf(e.value || '') >= 0
      }
    } catch (err) {
      actual = String(err)
    }
    if (e.negate) ok = !ok
    return { ok, actual }
  })
})

/** 页面探测（失败三分类用）：当前 URL + 页面文本片段 */
const PROBE_FN = String(() => ({
  url: location.href,
  text: ((document.body && document.body.innerText) || '').slice(0, 2000)
}))

function expectDesc(e: CaseExpect): string {
  const target = e.selector ? `${e.selector}` : ''
  const val = e.value != null ? `「${e.value}」` : ''
  return `${e.negate ? 'NOT ' : ''}${e.kind}${target ? ' ' + target : ''} ${val}`.trim()
}

function skipCase(name: string, source: CaseResult['source'], reason: string): CaseResult {
  return { name, source, status: 'skipped', reason, steps: 0, durationMs: 0, stepMs: [], tokens: { input: 0, output: 0 }, expects: [] }
}

/** cases.json（真实站点用例）：env 指定 > 仓库内 > 旁路覆盖；无配置返回空（报告标 skipped） */
function loadConfigCases(): ConfigCase[] {
  const candidates = [
    process.env.EASYBOW_REGRESSION_CASES,
    join(process.cwd(), 'src/main/regression/cases.json'),
    join(process.cwd(), 'regression-cases.json')
  ].filter(Boolean) as string[]
  const kinds = ['text_visible', 'url_contains', 'selector_exists', 'selector_text', 'selector_value']
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const arr = Array.isArray(raw?.cases) ? raw.cases : []
      return arr
        .filter((c: any) => c && typeof c.name === 'string' && typeof c.task === 'string')
        .map((c: any): ConfigCase => ({
          name: String(c.name),
          startUrl: typeof c.startUrl === 'string' && c.startUrl ? c.startUrl : undefined,
          task: String(c.task),
          expects: Array.isArray(c.expects)
            ? c.expects
                .filter((x: any) => x && kinds.includes(String(x.kind)))
                .map((x: any) => ({
                  kind: x.kind,
                  value: x.value != null ? String(x.value) : undefined,
                  selector: x.selector != null ? String(x.selector) : undefined,
                  negate: x.negate === true ? true : undefined
                }))
            : [],
          timeoutMs: typeof c.timeoutMs === 'number' && c.timeoutMs > 0 ? c.timeoutMs : undefined,
          enabled: c.enabled !== false
        }))
    } catch {
      /* 配置损坏：跳过该候选 */
    }
  }
  return []
}

/** 跑一个任务型用例：导航起始页 → AgentRunner 跑任务 → expect 验收 → 失败三分类 */
async function runCase(
  deps: { runner: AgentRunner; tabManager: TabManager; stepSink: { recs: StepRecord[] } },
  def: RegressionCase,
  source: CaseResult['source']
): Promise<CaseResult> {
  const { runner, tabManager, stepSink } = deps
  const started = Date.now()
  const base: CaseResult = {
    name: def.name,
    source,
    status: 'skipped',
    steps: 0,
    durationMs: 0,
    stepMs: [],
    tokens: { input: 0, output: 0 },
    expects: []
  }

  if (def.startUrl) {
    if (!tabManager.active()) tabManager.newTab('about:blank')
    await tabManager.navigate(def.startUrl)
    await sleep(1500)
  }

  // 跑任务（trace 与步记录按用例切片）
  stepSink.recs = []
  const before = listTraceFiles()
  const timeoutMs = def.timeoutMs && def.timeoutMs > 0 ? def.timeoutMs : CASE_TIMEOUT_MS
  let captcha = false
  let timedOut = false
  let finalState = ''
  let statusText = ''
  try {
    await runner.startTask(def.task)
  } catch (e: any) {
    return { ...base, reason: `任务未启动: ${String(e?.message || e)}`, durationMs: Date.now() - started }
  }
  for (;;) {
    await sleep(500)
    const st = runner.getStatus()
    finalState = st.state
    statusText = st.statusText
    if (st.state === 'done' || st.state === 'error' || st.state === 'stopped') break
    if (st.state === 'captcha') {
      // 无人值守：验证码直接收尾归 infra（登录/验证码属环境失败，不计入成功率）
      captcha = true
      runner.stopTask()
      break
    }
    if (Date.now() - started > timeoutMs) {
      timedOut = true
      runner.stopTask()
      break
    }
  }
  const endTs = Date.now()
  const usage = runner.getStatus().usage
  const fresh = [...listTraceFiles()].filter((f) => !before.has(f))
  const stepMs = stepDurations(readTraceEvents(fresh), stepSink.recs, endTs)

  // expect 验收 + 页面探测（三分类特征）
  const tab = tabManager.active()
  let pageUrl = ''
  let pageText = ''
  let expectResults: ExpectResult[] = []
  if (tab) {
    try {
      const probe = await tab.cdp.evaluate<{ url: string; text: string }>(PROBE_FN, [])
      pageUrl = probe?.url || ''
      pageText = probe?.text || ''
    } catch {}
    if (def.expects.length) {
      try {
        const raw = await tab.cdp.evaluate<Array<{ ok: boolean; actual: string }>>(EXPECT_FN, [def.expects])
        expectResults = def.expects.map((x, i) => ({ desc: expectDesc(x), ok: !!raw?.[i]?.ok, actual: raw?.[i]?.actual }))
      } catch (e: any) {
        const msg = String(e?.message || e)
        expectResults = def.expects.map((x) => ({ desc: expectDesc(x), ok: false, actual: msg }))
      }
    }
  } else {
    expectResults = def.expects.map((x) => ({ desc: expectDesc(x), ok: false, actual: '无活动页签' }))
  }

  // 判定与三分类（横切约束 3）
  const failReasons: string[] = []
  if (captcha) failReasons.push('命中验证码（无人值守自动收尾）')
  if (timedOut) failReasons.push(`任务超时（>${Math.round(timeoutMs / 1000)}s）`)
  if (!captcha && !timedOut && finalState !== 'done') failReasons.push(`任务结束状态 ${finalState}${statusText ? `（${statusText}）` : ''}`)
  for (const x of expectResults) {
    if (!x.ok) failReasons.push(`断言未过: ${x.desc}${x.actual != null ? `（实际: ${x.actual}）` : ''}`)
  }

  const result: CaseResult = {
    ...base,
    status: failReasons.length ? 'failed' : 'passed',
    steps: usage.steps || stepSink.recs.length,
    durationMs: endTs - started,
    stepMs,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
    expects: expectResults
  }
  if (failReasons.length) {
    result.reason = failReasons.join('；')
    result.triage = captcha ? 'infra' : classifyFailure(result.reason, pageUrl, pageText).triage
  }
  return result
}

/** 回归入口：顺序跑 3 个任务型用例 → 报告落盘 → 打印报告路径并退出进程 */
export async function runRegression(): Promise<void> {
  const startedAt = Date.now()
  console.log('[regression] 回归开始（任务型用例 + expect 验收 + 失败三分类报告）')
  seedSettings()

  // 主窗口仅承载页签视图（回归无 UI），浏览器区域给全窗口
  const win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#f5f6f8' })
  const tabManager = new TabManager(win, () => {})
  const layout = () => {
    const b = win.getContentBounds()
    tabManager.setBrowserRect({ x: 0, y: 0, width: b.width, height: b.height })
  }
  layout()
  win.on('resize', layout)
  const executor = new Executor(tabManager)
  const stepSink: { recs: StepRecord[] } = { recs: [] }
  const runner = new AgentRunner(tabManager, executor, (ev: MainEvent) => {
    if (ev.channel === 'step') stepSink.recs.push(ev.step)
  })

  const srv = await startFixtureServer(fixturesDir())
  const results: CaseResult[] = []
  const noKey = !getSettings().apiKey
  const keySkipReason = '未配置 AI 接口（baseURL/API Key/模型）：任务型用例需 LLM，可设 EASYBOW_API_KEY 等环境变量或复用正式 profile 配置'

  const runOne = async (def: RegressionCase, source: CaseResult['source']) => {
    console.log(`[regression] ▶ ${def.name}`)
    const r = await runCase({ runner, tabManager, stepSink }, def, source)
    console.log(`[regression] ${r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'SKIP'} ${r.name}${r.reason ? ' — ' + r.reason : ''}`)
    results.push(r)
    await sleep(1000)
  }

  // 用例 1：本地 fixture（同名按钮列表 → 第 3 行查看）
  const fixtureCase: RegressionCase = {
    name: 'fixture-同名按钮列表(第3行查看)',
    startUrl: `${srv.baseUrl}/same-name-list.html`,
    task: '点击第 3 行的查看按钮',
    expects: [{ kind: 'selector_text', selector: '#result', value: '第 3 行' }]
  }
  if (noKey) results.push(skipCase(fixtureCase.name, 'fixture', keySkipReason))
  else await runOne(fixtureCase, 'fixture')

  // 用例 2/3：真实站点占位（cases.json；未配置/未启用标 skipped）
  const config = loadConfigCases()
  const realCases: ConfigCase[] = config.length
    ? config
    : [
        { name: '真实站点-占位1', task: '（cases.json 未配置）', expects: [], enabled: false },
        { name: '真实站点-占位2', task: '（cases.json 未配置）', expects: [], enabled: false }
      ]
  for (const c of realCases) {
    if (noKey) {
      results.push(skipCase(c.name, 'cases.json', keySkipReason))
      continue
    }
    if (c.enabled === false) {
      results.push(
        skipCase(
          c.name,
          'cases.json',
          config.length
            ? '模板用例未启用（enabled=false）：请配置真实站点、人工预热登录态后改为 true'
            : '未找到 cases.json 配置：请在 src/main/regression/cases.json 配置真实站点用例'
        )
      )
      continue
    }
    await runOne({ name: c.name, startUrl: c.startUrl, task: c.task, expects: c.expects, timeoutMs: c.timeoutMs }, 'cases.json')
  }

  // 报告落盘 + 收尾退出（失败非零，便于 CI 判定）
  const reportPath = writeReport(results, startedAt)
  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  console.log(`\n========== 回归结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ==========`)
  console.log(`[regression] 报告已生成: ${reportPath}`)
  srv.close()
  try {
    runner.dispose()
  } catch {}
  try {
    tabManager.destroyAll()
  } catch {}
  try {
    win.destroy()
  } catch {}
  process.exit(failed > 0 ? 1 : 0)
}
