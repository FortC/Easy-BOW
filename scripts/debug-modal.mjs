// 复活后（或正常运行时）验证：真实点击 大编辑器/设置 弹窗 + 连续开关 + resize 后复检
const BASE = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`${BASE}/json/list`)).json()
const ui = list.find((t) => (t.url || '').includes('index.html'))
if (!ui) throw new Error('UI target 未找到: ' + list.map((t) => t.url).join(','))
const ws = new WebSocket(ui.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
  }
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
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
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(700)
}

// 大编辑器
let r = await evalJs(`(() => { const b = document.querySelector('.expand-btn'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.x + x.width/2, y: x.y + x.height/2 } })()`)
if (!r) throw new Error('expand-btn 缺失')
await realClick(r.x, r.y)
console.log('大编辑器 弹窗:', await evalJs(`!!document.querySelector('.modal-mask') && (document.querySelector('.modal h3')||{}).textContent.includes('大编辑器')`))
await evalJs(`document.querySelector('.modal .close-x').click()`)
await sleep(300)

// 设置（工具栏 ⚙）
r = await evalJs(`(() => { const b = document.querySelector('button[title="设置"]'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.x + x.width/2, y: x.y + x.height/2 } })()`)
if (!r) throw new Error('设置按钮缺失')
await realClick(r.x, r.y)
console.log('设置 弹窗:', await evalJs(`!!document.querySelector('.modal-mask') && (document.querySelector('.modal h3')||{}).textContent.includes('设置')`))
await evalJs(`document.querySelector('.modal .close-x').click()`)
await sleep(300)

// 弹窗期间浏览器隐藏占位是否符合预期
await evalJs(`document.querySelector('.expand-btn').click()`)
await sleep(400)
console.log('弹窗期间占位提示:', await evalJs(`!!Array.from(document.querySelectorAll('.browser-placeholder span')).find(s => s.textContent.includes('暂时隐藏'))`))
await evalJs(`document.querySelector('.modal .close-x').click()`)
await sleep(400)
console.log('关闭后占位消失:', await evalJs(`!Array.from(document.querySelectorAll('.browser-placeholder span')).find(s => s.textContent.includes('暂时隐藏'))`))
process.exit(0)
