// 验证 UI 渲染器卡死自愈：注入 while(true){} 阻塞主线程 → 等待自动强杀重建 → 心跳恢复 + 弹窗可用
const BASE = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connectUi() {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  return list.find((t) => t.url.includes('index.html') || (t.title || '').includes('EasyBow'))
}
let ws
let seq = 0
const pending = new Map()
async function connect() {
  const ui = await connectUi()
  if (!ui) return false
  ws = new WebSocket(ui.webSocketDebuggerUrl)
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
    }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  return true
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++seq
  pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
  return r.result?.value
}
async function heartbeat(ms = 3000) {
  await Promise.race([
    send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
    sleep(ms).then(() => { throw new Error('TIMEOUT') })
  ])
}

console.log('1) 连接 UI …')
if (!(await connect())) throw new Error('UI target 未找到')
console.log('   初始心跳…', await heartbeat().then(() => 'ok').catch(() => 'FAIL'))

console.log('2) 注入死循环卡死 UI 渲染器 …')
ws.send(JSON.stringify({ id: 99901, method: 'Runtime.evaluate', params: { expression: 'var t=Date.now(); while(Date.now()-t<60000){}' } }))
await sleep(1500)
console.log('   心跳应超时:', await heartbeat(2000).then(() => '**未超时(异常)**').catch((e) => e.message))
console.log('   等待自愈（unresponsive 6s + 探测 3s + 重建）…')

// 轮询等待 UI 复活（渲染器重建后 target id 会变化，需要重连）
let recovered = false
for (let i = 0; i < 30; i++) {
  await sleep(2000)
  try {
    pending.clear()
    seq = 0
    ws.close()
  } catch {}
  try {
    if (!(await connect())) continue
    await heartbeat(2000)
    recovered = true
    console.log(`   ✓ 第 ${i + 1} 次探测时 UI 已恢复`)
    break
  } catch {
    process.stdout.write('.')
  }
}
if (!recovered) {
  console.log('\n!!! 自愈失败：UI 未恢复')
  process.exit(1)
}

console.log('3) 复活后功能验证：真实点击 大编辑器 …')
await sleep(1500)
const r = await evalJs(`(() => { const b = document.querySelector('.expand-btn'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 } })()`)
if (!r) {
  console.log('!!! expand-btn 不存在', await evalJs(`document.querySelector('.tabbar') ? 'tabbar存在' : 'tabbar缺失'`))
  process.exit(1)
}
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
await sleep(60)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
await sleep(40)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
await sleep(800)
const state = await evalJs(`!!document.querySelector('.modal-mask') && !!(document.querySelector('.modal h3')||{}).textContent.match(/大编辑器/)`)
console.log('   大编辑器弹窗打开:', state)
console.log(state ? '=== 自愈验证通过 ===' : '=== 弹窗验证失败 ===')
process.exit(state ? 0 : 1)
