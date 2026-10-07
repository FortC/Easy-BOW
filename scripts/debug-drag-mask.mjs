// 拖动期间遮罩专项监控：真实任务执行 drag（测试页滑块），500ms 高频采样 B-R + overlay 状态
import { execFile } from 'child_process'
import { promisify } from 'util'
const pexec = promisify(execFile)

const BASE = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PS = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct R { public int L, T, Rt, B; }
}
"@
$proc = Get-Process EasyBow,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -notmatch 'OCR Worker' } | Select-Object -First 1
if (-not $proc) { Write-Host "BR=NOWIN"; exit 0 }
$r = New-Object W+R
[void][W]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = $r.Rt - $r.L; $h = $r.B - $r.T
if ($w -lt 200 -or $h -lt 200) { Write-Host "BR=NOWIN"; exit 0 }
# 先把窗口置顶，避免其他窗口遮挡导致采样伪影
[void][W]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 60
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$sum = 0.0; $n = 0
for ($x = [int]($w*0.10); $x -lt [int]($w*0.60); $x += 8) {
  for ($y = [int]($h*0.18); $y -lt [int]($h*0.75); $y += 8) {
    $c = $bmp.GetPixel($x, $y); $sum += ($c.B - $c.R); $n++
  }
}
$g.Dispose(); $bmp.Dispose()
Write-Host ("BR=" + [math]::Round($sum / $n, 1))
`

async function pixel() {
  try {
    const { stdout } = await pexec('powershell', ['-NoProfile', '-Command', PS], { timeout: 12000 })
    const m = stdout.trim().match(/BR=(-?[\d.]+)/)
    return m ? parseFloat(m[1]) : null
  } catch {
    return null
  }
}

async function connect(match) {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  return list.find((t) => (t.url || '').includes(match))
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
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq
    pend.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  return { ws, ready, send, evalJs: (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value) }
}

const uiT = await connect('app.asar') || await connect('index.html')
const ovT = await connect('overlay.html')
const ui = mkWs(uiT.webSocketDebuggerUrl)
const ov = mkWs(ovT.webSocketDebuggerUrl)
await Promise.all([ui.ready, ov.ready])

console.log('启动真实任务：打开测试页并拖动滑块 …')
await ui.evalJs(`window.easybow.startTask("打开 ${'file:///G:/pjs/easybow/resources/testpage.html'}，然后用 drag 把滑块手柄拖到最右边，最后 done")`).catch(() => {})

let maskOffDuringRunning = 0
let samples = 0
let sawDrag = false
const t0 = Date.now()
while (Date.now() - t0 < 150000) {
  const [br, ovs, st] = await Promise.all([
    pixel(),
    ov.evalJs('window.__ovl ? window.__ovl.state() : null').catch(() => null),
    ui.evalJs('window.easybow.getAgentStatus().then(s => s.state + "/" + s.stepCount + "/" + (s.statusText||"").slice(0,24))').catch(() => 'ui-err')
  ])
  samples++
  const running = st.startsWith('running')
  const maskOn = br != null && br > 7
  if (st.includes('拖') || (ovs && ovs.moves > 0 && running)) sawDrag = true
  if (running && !maskOn) {
    maskOffDuringRunning++
    console.log(`  ⚠ 运行中无遮罩: B-R=${br} ovWorking=${ovs?.working} bar=${ovs?.barVisible} moves=${ovs?.moves} clicks=${ovs?.clicks} | ${st}`)
  } else {
    process.stdout.write(`[B-R=${br} w=${ovs?.working} m=${ovs?.moves}/${ovs?.clicks} ${st.slice(0, 30)}] `)
  }
  if (/^(done|error|stopped)/.test(st)) {
    console.log(`\n任务结束: ${st}`)
    break
  }
  await sleep(600)
}
console.log(`\n采样 ${samples} 次，运行中无遮罩 ${maskOffDuringRunning} 次，观察到拖动=${sawDrag}`)
process.exit(0)
