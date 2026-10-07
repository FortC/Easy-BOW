// 挂死模拟：LLM 中转 accept 后不响应 → 任务卡"思考中" → 暂停 → 继续 → 验证能到终态（不卡死）
import net from 'net'
import { readFileSync, writeFileSync, copyFileSync } from 'fs'
import { exec } from 'child_process'

const UA = process.env.APPDATA + '/Electron/settings.json'
copyFileSync(UA, UA + '.bak')
const s = JSON.parse(readFileSync(UA, 'utf8'))
s.baseURL = 'http://127.0.0.1:19999/v1'
s.provider = 'openai'
writeFileSync(UA, JSON.stringify(s, null, 2))

// 挂死服务器：accept 后永不响应
const srv = net.createServer((sock) => {
  sock.on('data', () => {}) // 吞掉请求，不回复
})
srv.listen(19999, '127.0.0.1', async () => {
  console.log('挂死服务器 :19999 就绪')
  try {
    await main()
  } finally {
    srv.close()
    copyFileSync(UA + '.bak', UA)
    console.log('settings 已恢复')
  }
})

async function main() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 启动应用
  exec('npx electron out/main/index.js --remote-debugging-port=9222 > hang-run.log 2>&1', { cwd: 'G:/pjs/easybow' })
  await sleep(9000)
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const ui = list.find((t) => (t.url || '').includes('index.html'))
  if (!ui) throw new Error('UI 未找到')
  const ws = new WebSocket(ui.webSocketDebuggerUrl)
  let seq = 0
  const pend = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id)
      pend.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const send = (method, params) => new Promise((res, rej) => { const i = ++seq; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evalJs = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result?.value })
  const st = () => evalJs('window.easybow.getAgentStatus().then(s => s.state + " | " + (s.statusText||"").slice(0, 30))')

  console.log('1) 发起任务（LLM 将挂死）…')
  await evalJs(`window.easybow.startTask('打开百度搜索天气')`).catch(() => {})
  await sleep(4000)
  console.log('   状态:', await st(), '(预期 running/思考中)')

  console.log('2) 暂停 …')
  await evalJs('window.easybow.pauseTask()')
  await sleep(2500)
  const paused = await st()
  console.log('   状态:', paused, '(预期 paused)')
  const pausedOk = paused.includes('paused')

  console.log('3) 继续 …')
  await evalJs('window.easybow.resumeTask()')
  await sleep(3000)
  console.log('   状态:', await st())

  console.log('4) 等待任务到达终态（最长 120s）…')
  let final = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    await sleep(4000)
    try {
      final = await st()
    } catch {
      final = '(ui 不可达)'
    }
    if (/error|done|stopped/.test(final)) break
  }
  console.log('   最终状态:', final, `(耗时 ${Math.round((Date.now() - t0) / 1000)}s)`)
  const ok = pausedOk && /error|done|stopped/.test(final)
  console.log(ok ? '=== 挂死恢复验证通过 ===' : '=== 验证失败 ===')
  const { execSync } = await import('child_process')
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch {}
  process.exit(ok ? 0 : 1)
}
