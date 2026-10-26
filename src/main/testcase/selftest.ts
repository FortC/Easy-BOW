import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { getSettings, saveSettings } from '../settings'
import { benchmarkModel } from './modelBenchmark'
import { fetchAxTree } from '../axtree'
import { runByKey } from '../frameAccess'
import { decodeImageToPng } from '../imgdec'
import { AgentRunner } from '../agent/runner'
import { parseTestCase, parseAssertionLine } from './parser'
import { parseTestSuite, splitCaseMarkdown, suiteCoverage, selectFailedCases } from './suite'
import { compileRequirements, requirementChunks } from './requirements'
import { evaluateAssertion, type AssertionPage } from './evaluate'
import { candidateTarget, resolveTarget, reusableActions } from './plans'
import { updateStep } from './edit'
import { renderCaseMd } from './report'
import { convertRequirement } from './converter'
import type { TabManager } from '../tabs'
import type { Executor } from '../executor'
import type { AgentAction, TestCase } from '../../shared/types'

export async function runTestingSelftest(tm: TabManager, executor: Executor): Promise<number> {
  // 自测覆盖真实命中链路；视觉复核使用本地替身，绝不请求外部模型端点。
  const originalVerifier = executor.clickVerifier
  executor.clickVerifier = async () => ({ ok: true })
  let passed = 0
  let failed = 0
  const test = async (name: string, run: () => unknown | Promise<unknown>) => {
    try { await run(); passed++; console.log(`[PASS] ${name}`) }
    catch (error) { failed++; console.error(`[FAIL] ${name}`, error) }
  }
  const basic = (name: string, expected = '[文字] 包含 ready') => `# TESTCASE: ${name}\n- 需求: REQ-1\n- 验收点: AC-1\n## 步骤\n### 检查\n- 操作: 读取当前页面\n- 预期: ${expected}\n`
  await test('WebP 隐藏窗口解码连续运行稳定，PNG 签名有效', async () => {
    const webp = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')
    for (let i = 0; i < 5; i++) {
      const png = await decodeImageToPng(webp)
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    }
  })
  await test('多用例隔离解析、唯一断言 ID、覆盖缺口', () => {
    const suite = parseTestSuite(`# TESTSUITE: 示例\n- 验收点: AC-1, AC-2\n${basic('一')}\n${basic('二')}`).suite!
    assert.equal(suite.cases.length, 2)
    assert.notEqual(suite.cases[0].steps[0].assertions[0].id, suite.cases[1].steps[0].assertions[0].id)
    assert.equal(suiteCoverage(suite, [{ caseId: 'TC-001', state: 'passed' }])[0].status, 'not_run')
    assert.equal(suiteCoverage(suite, [])[1].status, 'uncovered')
    assert.equal(splitCaseMarkdown(`${basic('一')}\n\`\`\`md\n# TESTCASE: 假标题\n\`\`\``).documents.length, 1)
    assert.equal(selectFailedCases(suite, [2])[0].name, '二')
  })
  await test('长需求保留全文和验收点', () => {
    const input = 'x'.repeat(40001) + '\n- [ ] 末尾验收点'
    const c = compileRequirements(input)
    assert.equal(c.acceptance.length, 1)
    assert.equal(requirementChunks(c.annotated).join(''), c.annotated)
    assert.ok(requirementChunks(c.annotated).at(-1)?.includes('末尾验收点'))
    const ids = compileRequirements('- [ ] 无编号\n- [ ] AC-AUTO-001 已有编号').acceptance.map((a) => a.id)
    assert.equal(new Set(ids).size, 2)
  })
  await test('步骤编辑不吞掉后一个用例和元数据', () => {
    const result = updateStep(`${basic('一')}\n${basic('二')}`, 1, { action: '新的操作' })
    const suite = parseTestSuite(result.md!).suite!
    assert.equal(suite.cases.length, 2)
    assert.equal(suite.cases[1].requirementIds![0], 'REQ-1')
  })
  await test('清理与准备阶段及多组数据可往返保存', () => {
    const tc = parseTestCase(`${basic('阶段')}\n## 清理\n### 恢复\n- 操作: 清理数据`).tc!
    assert.equal(tc.steps.at(-1)?.phase, 'cleanup')
    tc.groups = [{ name: '组一', vars: { a: '1' } }]
    const roundtrip = parseTestCase(renderCaseMd(tc)).tc!
    assert.equal(roundtrip.steps.at(-1)?.phase, 'cleanup')
    assert.equal(roundtrip.groups![0].vars.a, '1')
  })
  const page: AssertionPage = { url: () => 'http://example.test/', title: () => 'ready', evaluate: async () => ({ ok: false, err: 'invalid-selector' }) as any, response: async () => null }
  const check = (action: AgentAction, mock = page) => evaluateAssertion(action, mock, {}, new AbortController().signal, async () => {})
  await test('无效选择器取反仍是求值错误', async () => {
    const a: AgentAction = { name: 'expect', kind: 'selector_exists', selector: '[', negate: true, timeoutMs: 0 }
    await check(a); assert.equal(a.assertionStatus, 'error')
  })
  await test('没有接口响应和响应体不可用不能取反通过', async () => {
    const a: AgentAction = { name: 'expect', kind: 'api_body', urlPart: '/api', value: 'error', negate: true, timeoutMs: 0 }
    await check(a); assert.equal(a.assertionStatus, 'error')
    await check(a, { ...page, response: async () => ({ status: 200, url: '/api' }) }); assert.equal(a.assertionStatus, 'error')
  })
  await test('断言 method 与请求检查点透传；空值和未知变量拒绝', async () => {
    const a: AgentAction = { name: 'expect', kind: 'api_status', urlPart: '/api', method: 'POST', networkSince: 6, value: '200', timeoutMs: 0 }
    await check(a, { ...page, response: async (url, since, method) => { assert.equal(since, 6); assert.equal(method, 'POST'); return { url, status: 200 } } })
    assert.equal(a.assertionStatus, 'passed')
    const b: AgentAction = { name: 'expect', kind: 'url_contains', value: '{{missing}}', negate: true, timeoutMs: 0 }
    await check(b); assert.equal(b.assertionStatus, 'error')
    assert.equal(parseAssertionLine('[接口 POST /api] 状态 = 200').method, 'POST')
    assert.equal(parseAssertionLine('[选择器 .error] 随便').kind, 'ai')
    assert.equal(parseAssertionLine('[选择器 input[name="email"]] 值=a').selector, 'input[name="email"]')
    assert.equal(parseAssertionLine('[文字] 页面出现「ready」').value, 'ready')
    assert.equal(parseAssertionLine('[url] 包含 /path').kind, 'url_contains')
  })
  await test('需求转换使用纯文本输出模式并生成多用例', async () => {
    const requests: string[] = []
    const provider: any = { chat: async (_system: string, messages: any[], _signal: unknown, opts: any) => {
      assert.equal(opts.plain, true); requests.push(messages[0].content)
      return { text: basic('生成一') + '\n' + basic('生成二'), usage: { inputTokens: 1, outputTokens: 1 } }
    } }
    const result = await convertRequirement(provider, 'x'.repeat(40001) + '\n- [ ] 文档尾部', 'prd')
    assert.ok(result.ok); assert.ok(requests.at(-1)!.includes('文档尾部')); assert.ok(requests.length >= 3)
    assert.equal(parseTestSuite(result.md!).suite!.cases.length, requests.length * 2)
  })
  // 以下直接驱动 Chromium 和真实执行器，不调用外部模型。
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return }
    if (req.url?.startsWith('/nested-parent')) { res.setHeader('Content-Type', 'text/html'); res.end('<iframe src="/nested-field"></iframe>'); return }
    if (req.url?.startsWith('/nested-field')) { res.setHeader('Content-Type', 'text/html'); res.end('<input placeholder="nested-field">'); return }
    if (req.url?.startsWith('/frame')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>frame-ready</title><p class="frameval">frame-ready</p>'); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<title>ready</title><p>ready</p><input placeholder="姓名"><button onclick="document.title=\'clicked\'">保存</button><button>取消</button><div class="error-msg">必填错误</div>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  try {
    await tm.navigate(url)
    await new Promise((r) => setTimeout(r, 300))
    const makeRunner = (tc: TestCase, failFast = true): any => {
      const runner: any = new AgentRunner(tm, executor, () => {})
      runner.abortCtrl = new AbortController()
      runner.state = { ...runner.state, state: 'running', memory: {} }
      runner.testCtx = { tc, stepIdx: 0, epoch: 0, failFast, perStepModelSteps: 0, protectedSubmit: false, fillPreview: false,
        loginReuse: false, networkCheckpoints: new Map(tm.all().map((t) => [t.id, t.cdp.networkCheckpoint()])), originalTabIds: new Set(tm.all().map((t) => t.id)), stepActions: [] }
      runner.testRun = { state: 'running', caseName: tc.name, totalSteps: tc.steps.length, currentStep: 1, passed: 0, failed: 0, tokens: { input: 0, output: 0 }, steps: tc.steps.map((s, i) => ({ index: i + 1, title: s.title, phase: s.phase, status: 'running', assertions: [], modelSteps: 0 })) }
      return runner
    }
    await test('模型漏断言/重复断言不能充数，原脚本全部执行', async () => {
      const tc = parseTestCase(basic('独立断言') + '- 预期: [标题] 包含 ready\n').tc!
      const runner = makeRunner(tc)
      await runner.handleTestPostBatch([{ name: 'expect', kind: 'url_contains', value: 'fake', result: '通过' }], true)
      const result = runner.testRun.steps[0]
      assert.equal(result.status, 'passed'); assert.equal(result.assertions.length, 2)
      assert.equal(new Set(result.assertions.map((a: any) => a.id)).size, 2)
    })
    await test('负向业务测试的预期错误不会被软断言误判', async () => {
      const runner = makeRunner(parseTestCase(basic('负向', '[文字] 包含 必填错误')).tc!)
      runner.testSoftErrors = ['检测到表单错误']
      await runner.handleTestPostBatch([], true)
      assert.equal(runner.testRun.steps[0].status, 'passed')
    })
    await test('断言阶段暂停后保留进度，恢复不重复业务操作', async () => {
      const runner = makeRunner(parseTestCase(basic('暂停断言')).tc!)
      const original = executor.checkAssertion.bind(executor)
      executor.checkAssertion = async () => { runner.pauseTask(); throw new Error('暂停中断') }
      try {
        assert.equal(await runner.handleTestPostBatch([], true), true)
        assert.equal(runner.testCtx.pendingStepCompletion, true)
        assert.equal(runner.testRun.steps[0].assertions.length, 0)
        runner.resumeTask()
        await runner.checkpoint()
      } finally { executor.checkAssertion = original }
      assert.equal(await runner.handleTestPostBatch([], true), false)
      assert.equal(runner.testRun.steps[0].status, 'passed')
    })
    await test('隐藏 Shadow 文字不能冒充可见；多目标值断言拒绝歧义', async () => {
      await tm.active()!.cdp.evaluate('function(){const host=document.createElement("div");host.id="shadow-case";document.body.append(host);host.attachShadow({mode:"open"}).innerHTML="<span style=display:none>hidden-sentinel</span><b>visible-shadow</b>";document.body.insertAdjacentHTML("beforeend","<input class=ambiguous><input class=ambiguous>")}', [])
      try {
        for (const [value, negate] of [['hidden-sentinel', true], ['visible-shadow', false]] as const) {
          const a = await executor.checkAssertion({ name: 'expect', kind: 'text_visible', value, negate, timeoutMs: 0 }, { settings: {} as any, memory: {}, signal: new AbortController().signal })
          assert.equal(a.assertionStatus, 'passed', JSON.stringify(a))
        }
        const a = await executor.checkAssertion({ name: 'expect', kind: 'selector_value', selector: '.ambiguous', value: '', negate: true, timeoutMs: 0 }, { settings: {} as any, memory: {}, signal: new AbortController().signal })
        assert.equal(a.assertionStatus, 'error')
      } finally { await tm.active()!.cdp.evaluate('function(){document.getElementById("shadow-case").remove();document.querySelectorAll(".ambiguous").forEach(e=>e.remove())}', []) }
    })
    await test('跨域 iframe 显式作用域断言与不可达框架错误', async () => {
      const tab = tm.active()!
      await tab.cdp.evaluate('function(src){const f=document.createElement("iframe");f.src=src;document.body.append(f)}', [url.replace('127.0.0.1', 'localhost') + '/frame'])
      await new Promise((r) => setTimeout(r, 500))
      try {
        const parsed = parseAssertionLine('[框架 0.0] [选择器 .frameval] 文本=frame-ready')
        assert.equal(parsed.frameKey, '0.0')
        const a = await executor.checkAssertion({ ...parsed, name: 'expect', kind: 'selector_text', timeoutMs: 0 }, { settings: {} as any, memory: {}, signal: new AbortController().signal })
        assert.equal(a.assertionStatus, 'passed', JSON.stringify(a))
        const missing = await executor.checkAssertion({ name: 'expect', frameKey: '0.99', kind: 'selector_exists', selector: '.frameval', negate: true, timeoutMs: 0 }, { settings: {} as any, memory: {}, signal: new AbortController().signal })
        assert.equal(missing.assertionStatus, 'error')
      } finally { await tab.cdp.evaluate('function(){document.querySelector("iframe").remove()}', []) }
    })
    await test('AX Tree 从浏览器 properties 读取禁用与勾选状态', async () => {
      const tab = tm.active()!
      await tab.cdp.evaluate('function(){document.body.insertAdjacentHTML("beforeend","<button id=ax-disabled disabled>AX禁用</button><input id=ax-checked aria-label=AX勾选 type=checkbox checked>")}', [])
      try {
        const items = await fetchAxTree(tab.cdp, 150, ['AX禁用', 'AX勾选'])
        assert.ok(items.find((a) => a.desc.includes('ax禁用'))?.state?.includes('disabled'), JSON.stringify(items))
        assert.ok(items.find((a) => a.desc.includes('ax勾选'))?.state?.includes('已勾选'), JSON.stringify(items))
      } finally { await tab.cdp.evaluate('function(){document.getElementById("ax-disabled").remove();document.getElementById("ax-checked").remove()}', []) }
    })
    await test('跨域 frame 内的同源嵌套字段保留定位链，局部查询不混入无关候选', async () => {
      const tab = tm.active()!
      await tab.cdp.evaluate('function(src){const f=document.createElement("iframe");f.src=src;document.body.append(f)}', [url.replace('127.0.0.1', 'localhost') + '/nested-parent'])
      await new Promise((r) => setTimeout(r, 600))
      try {
        const res = await executor.extract(tab, { limit: 200, query: 'nested-field' })
        const index = res.candidates.findIndex((c) => c.extra.includes('nested-field'))
        assert.ok(index >= 0, JSON.stringify(res))
        assert.equal(res.totalFound, res.candidates.length)
        assert.ok(res.candidates[index].framePaths.length > 0)
        const out = await executor.executeBatch([{ name: 'type', index, text: '{{nested}}' }], { memory: { nested: 'nested-ok' }, settings: { speed: 'fast' } as any, signal: new AbortController().signal })
        assert.ok(!out[0].error, out[0].error || '')
        assert.equal(await runByKey(tab.view.webContents, '0.0', 'function(){return document.querySelector("iframe").contentDocument.querySelector("input").value}', []), 'nested-ok')
      } finally { await tab.cdp.evaluate('function(){document.querySelector("iframe").remove()}', []) }
    })
    await test('fail-fast 跳过业务步骤但仍执行所有清理步骤', async () => {
      const tc = parseTestCase(basic('清理', '[标题] 包含 ready') + '### 下一业务\n- 操作: 继续\n## 清理\n### 清理一\n- 操作: 清理\n### 清理二\n- 操作: 清理\n').tc!
      const runner = makeRunner(tc)
      tc.steps[0].assertions[0].timeoutMs = 0
      tc.steps[0].assertions[0].value = 'missing'
      assert.equal(await runner.handleTestPostBatch([], true), true)
      assert.equal(runner.testCtx.stepIdx, 2); assert.equal(runner.testRun.steps[1].status, 'skipped')
      runner.testCtx.perStepModelSteps = 7
      assert.equal(await runner.handleTestPostBatch([{ name: 'click', error: '无法清理' }], false), true)
      assert.equal(runner.testCtx.stepIdx, 3)
      assert.equal(await runner.handleTestPostBatch([], true), false)
    })
    await test('停止立即中止；未执行清理明确写入报告', () => {
      const runner = makeRunner(parseTestCase(basic('停止') + '## 清理\n### 恢复\n- 操作: 清理').tc!)
      runner.testCollectMode = true
      runner.stopTask()
      assert.equal(runner.testRun.state, 'stopped')
      assert.match(runner.testRun.steps[1].error, /清理未执行/)
      assert.ok(runner.abortCtrl.signal.aborted)
    })
    await test('强制重置兑现序列等待，不遗留无法再运行的状态', () => {
      const runner = makeRunner(parseTestCase(basic('重置')).tc!)
      let resolved = false
      runner.testCollectMode = true
      runner.testSequenceRunning = true
      runner.testDoneResolve = { epoch: 0, resolve: () => { resolved = true } }
      runner.resetTestRun()
      assert.ok(resolved)
      assert.equal(runner.testSequenceRunning, false)
      assert.equal(runner.getTestRunStatus().state, 'stopped')
    })
    await test('真实 CDP 接口断言拒绝旧请求和未完成请求', async () => {
      const tab = tm.active()!
      tab.cdp.setNetworkCapture(true)
      await tab.cdp.evaluate('async function(){await fetch("/api/old")}', [])
      await new Promise((r) => setTimeout(r, 100))
      const checkpoint = tab.cdp.networkCheckpoint()
      assert.equal(await tab.cdp.findResponseBody('/api/old', checkpoint), null)
      await tab.cdp.evaluate('async function(){await fetch("/api/new",{method:"POST"})}', [])
      await new Promise((r) => setTimeout(r, 100))
      assert.equal((await tab.cdp.findResponseBody('/api/new', checkpoint, 'POST'))?.status, 200)
      assert.equal(await tab.cdp.findResponseBody('/api/new', checkpoint, 'GET'), null)
    })
    await test('语义重定位与计划参数化不保留旧编号/输入凭据', async () => {
      const snapshot = await executor.extract()
      const input = snapshot.candidates.find((c) => c.tag === 'INPUT')!
      const target = candidateTarget(input)
      assert.ok(resolveTarget(target, snapshot.candidates) >= 0)
      assert.equal(resolveTarget(target, [input, input]), -1)
      const actions = reusableActions([{ name: 'type', index: 42, target, text: 'secret' }], { username: 'secret' })!
      assert.equal(actions[0].text, '{{username}}'); assert.equal(actions[0].index, undefined)
      assert.ok(!JSON.stringify(actions).includes('secret'))
      const out = await executor.executeBatch(actions, { settings: { speed: 'fast' } as any, memory: { username: '测试姓名' }, signal: new AbortController().signal })
      assert.ok(!out[0]?.error, out[0]?.error || '动作应成功')
      assert.equal(await tm.active()!.cdp.evaluate('function(){return document.querySelector("input").value}', []), '测试姓名')
    })
    await test('过期快照拒绝执行', async () => {
      const old = await executor.extract(); await executor.extract()
      const result = await executor.executeBatch([{ name: 'click', index: 0, snapshotId: old.snapshotId }], { settings: { speed: 'fast' } as any, memory: {}, signal: new AbortController().signal })
      assert.match(result[0].error || '', /快照已失效/)
    })
    await test('干净会话清除跨用例存储，复用模式明确保留', async () => {
      let tab = tm.prepareTestTab(false)
      await tab.view.webContents.loadURL(url)
      await tab.cdp.evaluate('function(){localStorage.setItem("isolation","one")}', [])
      const first = tab.partition
      tab = tm.prepareTestTab(false)
      assert.notEqual(tab.partition, first)
      await tab.view.webContents.loadURL(url)
      assert.equal(await tab.cdp.evaluate('function(){return localStorage.getItem("isolation")}', []), null)
      tab = tm.prepareTestTab(true); await tab.view.webContents.loadURL(url)
      await tab.cdp.evaluate('function(){localStorage.setItem("isolation","saved")}', [])
      tab = tm.prepareTestTab(true); await tab.view.webContents.loadURL(url)
      assert.equal(await tab.cdp.evaluate('function(){return localStorage.getItem("isolation")}', []), 'saved')
    })
    await test('完整运行链：首次模型执行、第二次零模型复用、断言与覆盖报告', async () => {
      const original = getSettings()
      saveSettings({ apiKey: 'selftest-not-a-real-key', speed: 'fast', timelineShot: 'off', axTree: false, prescreen: false, telemetry: false, vision: false })
      let calls = 0
      const provider: any = { chat: async () => {
        calls++
        const ctx = (runner as any).testCtx
        if (ctx.stepIdx === 0) return { text: JSON.stringify({ actions: [{ name: 'goto', url: '{{base_url}}' }, { name: 'test_step_done' }] }), usage: { inputTokens: 1, outputTokens: 1 } }
        const snapshot = await executor.extract()
        return { text: JSON.stringify({ actions: [
          { name: 'type', index: snapshot.candidates.findIndex((c) => c.tag === 'INPUT'), text: '{{name}}' },
          { name: 'click', index: snapshot.candidates.findIndex((c) => c.text === '保存'), expect_text: '保存' }, { name: 'test_step_done' }
        ] }), usage: { inputTokens: 1, outputTokens: 1 } }
      } }
      const runner = new AgentRunner(tm, executor, () => {}, () => provider)
      const md = `# TESTSUITE: 流程复用\n- 验收点: AC-REPLAY\n# TESTCASE: 完整链路\n- 验收点: AC-REPLAY\n## 测试数据\n| 变量 | 值 |\n|---|---|\n| name | 测试姓名 |\n## 步骤\n### 导航\n- 操作: 访问 {{base_url}}\n- 预期: [URL] 包含 {{base_url}}\n### 填写\n- 操作: 填姓名并保存\n- 预期: [选择器 input] 值={{name}}\n- 预期: [标题] 包含 clicked`
      const run = async () => {
        await runner.startTestRun(md, { failFast: true, loginReuse: false, reusePlans: true, env: { name: 'fixture', baseUrl: url, protected: false } })
        const deadline = Date.now() + 30000
        while ((runner as any).testSequenceRunning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
        assert.ok(!(runner as any).testSequenceRunning, '完整链路超时')
        return runner.getTestRunStatus()!
      }
      try {
        const first = await run()
        assert.equal(first.state, 'passed', JSON.stringify(first.steps))
        assert.equal(first.coverage?.[0].status, 'passed')
        const firstCalls = calls
        assert.ok(firstCalls >= 2)
        const second = await run()
        assert.equal(second.state, 'passed', JSON.stringify(second.steps))
        assert.equal(calls, firstCalls, '复用不应重新调用模型')
        assert.equal(second.execution?.replayedSteps, 2)
        assert.match(readFileSync(second.reportPath!, 'utf-8'), /AC-REPLAY/)
      } finally { runner.stopTask(); saveSettings(original) }
    })
    await test('模型测评固定场景判定且档案不含密钥', async () => {
      const replies = [
        { name: 'click', index: 1 }, { name: 'click', index: 1, expect_text: '订单B 编辑' },
        { name: 'clarify', query: '哪个订单？' }, { name: 'click', index: 1 }, { name: 'type', index: 0, text: '{{email}}' }, { name: 'click', index: 0 }
      ]
      const provider: any = { chat: async () => ({ text: JSON.stringify({ actions: [replies.shift()] }), usage: { inputTokens: 1, outputTokens: 1 } }) }
      const report = await benchmarkModel(provider, { provider: 'openai', baseURL: 'https://example.test/api?key=secret', model: 'test', apiKey: 'secret' } as any)
      assert.equal(report.passed, 6)
      assert.ok(report.semanticQualified)
      assert.ok(!JSON.stringify(report).includes('secret'))
    })
  } finally { server.closeAllConnections(); server.close() }
  executor.clickVerifier = originalVerifier
  console.log(`Testing selftest: ${passed} passed, ${failed} failed`)
  return failed ? 1 : 0
}
