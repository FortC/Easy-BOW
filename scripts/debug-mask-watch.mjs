// 遮罩可见性时间线：OS 像素采样(B-R) + overlay 页面状态 + runner 状态，全程记录任务执行的遮罩连续性
import { execFile } from 'child_process'
import { promisify } from 'util'
const pexec = promisify(execFile)

const BASE = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PS_PIXEL = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L, T, Rt, B; }
}
"@
$proc = Get-Process EasyBow,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne 'EasyBow OCR Worker' } | Select-Object -First 1
if (-not $proc) { Write-Host "NOWIN"; exit 0 }
$r = New-Object W+R
[void][W]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = $r.Rt - $r.L; $h = $r.B - $r.T
if ($w -lt 200 -or $h -lt 200) { Write-Host "NOWIN"; exit 0 }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h)))
# 浏览器区域采样（左 12%~62% 宽，上 14%~80% 高 —— 避开页签/工具栏/右侧面板）
$sum = 0.0; $n = 0
for ($x = [int]($w*0.12); $x -lt [int]($w*0.62); $x += 9) {
  for ($y = [int]($h*0.14); $y -lt [int]($h*0.80); $y += 9) {
    $c = $bmp.GetPixel($x, $y); $sum += ($c.B - $c.R); $n++
  }
}
$g.Dispose(); $bmp.Dispose()
Write-Host ("BR=" + [math]::Round($sum / $n, 1))
`

async function samplePixel() {
  try {
    const { stdout } = await pexec('powershell', ['-NoProfile', '-Command', PS_PIXEL], { timeout: 15000 })
    const m = stdout.trim().match(/BR=(-?[\d.]+)/)
    return m ? parseFloat(m[1]) : null
  } catch {
    return null
  }
}

async function getTarget(match) {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  return list.find((t) => (t.url || '').includes(match) || (t.title || '').includes(match))
}

function mkWs(url) {
  const ws = new WebSocket(url)
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
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const send = (method, params = {}) => {
    if (ws.readyState !== 1) return Promise.reject(new Error('closed'))
    return new Promise((res, rej) => {
      const i = ++seq
      pend.set(i, { res, rej })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  }
  return { ws, ready, send, evalJs: (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value) }
}

console.log('连接 UI 与 overlay …')
const uiT = await getTarget('index.html')
const ovT = await getTarget('overlay.html')
const ui = mkWs(uiT.webSocketDebuggerUrl)
const ov = mkWs(ovT.webSocketDebuggerUrl)
await Promise.all([ui.ready, ov.ready])

const rows = []
async function tick(label) {
  const [br, ovState, st] = await Promise.all([
    samplePixel(),
    ov.evalJs('window.__ovl ? window.__ovl.state() : null').catch(() => null),
    ui.evalJs('window.easybow.getAgentStatus().then(s => s.state + "/" + s.stepCount + "/" + (s.statusText||"").slice(0,26))').catch(() => 'ui-err')
  ])
  const row = { t: label, br, ovWorking: ovState?.working, bar: ovState?.barVisible, moves: ovState?.moves, clicks: ovState?.clicks, st }
  rows.push(row)
  console.log(
    `[${label}] 遮罩B-R=${br ?? '?'} overlayWorking=${ovState?.working} bar=${ovState?.barVisible} 光标动画(移${ovState?.moves}/点${ovState?.clicks}) 任务=${st}`
  )
}

for (let i = 0; i < 3; i++) {
  await tick('基线' + (i + 1))
  await sleep(1500)
}

console.log('启动任务 …')
await ui.evalJs(`window.easybow.startTask('打开 https://www.baidu.com，搜索：今天天气，把第一条结果的标题读出来，然后 done')`).catch((e) => console.log('start err:', e.message?.slice(0, 120)))

for (let i = 0; i < 40; i++) {
  await tick(String(i + 1).padStart(2, '0'))
  await sleep(2000)
  const done = rows[rows.length - 1].st?.startsWith('done') || rows[rows.length - 1].st?.startsWith('error') || rows[rows.length - 1].st?.startsWith('stopped')
  if (done) {
    await tick('结束后')
    break
  }
}

console.log('\n=== 遮罩连续性分析 ===')
const taskRows = rows.filter((r) => r.st && !r.st.startsWith('idle') && !r.t.startsWith('基线'))
let gaps = 0
for (const r of taskRows) {
  const running = r.st.startsWith('running')
  const maskOn = r.br != null && r.br > 8
  if (running && !maskOn) {
    gaps++
    console.log(`  ⚠ 运行中无遮罩: [${r.t}] B-R=${r.br} ovWorking=${r.ovWorking} bar=${r.bar} ${r.st}`)
  }
}
console.log(`运行中采样 ${taskRows.filter((r) => r.st.startsWith('running')).length} 次，无遮罩 ${gaps} 次`)
process.exit(0)
