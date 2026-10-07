/**
 * 本地 OCR 模块（宿主侧）—— PP-OCR ONNX 在隐藏窗口渲染进程中用
 * onnxruntime-web (WASM) 免费离线推理，替代视觉模型省 token。
 * 用途：1) 图片按钮补标签 2) 图片型页面内容读取 3) DOM 提取失败降级。
 * 模型与 worker 页面位于 resources/ocr/，缺失时自动禁用。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ExtractResult } from '../extractor'
import type { TabManager } from '../tabs'

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

let workerWin: BrowserWindow | null = null
let ready = false
let initing: Promise<{ enabled: boolean; reason?: string }> | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ocrDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ocr') : join(__dirname, '../../resources/ocr')
}

function wireIpc(): void {
  ipcMain.handle('ocr:ready', () => true)
  ipcMain.handle('ocr:result', (_e, payload: { id: number; ok?: boolean; text?: string; labels?: (string | null)[]; error?: string }) => {
    const p = pending.get(payload.id)
    if (!p) return
    pending.delete(payload.id)
    clearTimeout(p.timer)
    if (payload.error) p.reject(new Error(payload.error))
    else p.resolve(payload)
    return true
  })
}

function ensureWindow(): BrowserWindow {
  if (workerWin && !workerWin.isDestroyed()) return workerWin
  workerWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/ocr-worker.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  workerWin.loadFile(join(ocrDir(), 'worker.html')).catch((e) => {
    console.error('[ocr] worker 页面加载失败:', e)
  })
  if (process.env.EASYBOW_DEBUG) {
    workerWin.webContents.on('console-message', (_e, _lvl, msg) => console.log('[ocr-worker]', msg))
    workerWin.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[ocr-worker] 加载失败', code, desc, url))
    workerWin.webContents.on('preload-error', (_e, path, err) => console.log('[ocr-worker] preload 错误', path, String(err)))
  }
  return workerWin
}

function callWorker(msg: Record<string, unknown>, timeoutMs = 30000, force = false): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!workerWin || workerWin.isDestroyed() || (!ready && !force)) {
      reject(new Error('OCR worker 未就绪'))
      return
    }
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('OCR 处理超时'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    workerWin.webContents.send('ocr:run', { id, ...msg })
  })
}

/** ArrayBuffer 走 IPC 需要转成可结构化克隆的形式 */
function toTransferable(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

export async function tryInitOcr(): Promise<{ enabled: boolean; reason?: string }> {
  if (initing) return initing
  initing = (async () => {
    const dir = ocrDir()
    const det = join(dir, 'det.onnx')
    const rec = join(dir, 'rec.onnx')
    const keys = join(dir, 'keys.txt')
    if (!existsSync(det) || !existsSync(rec) || !existsSync(keys)) {
      return { enabled: false, reason: `OCR 模型未找到（${dir}），图片识别功能已禁用` }
    }
    try {
      wireIpc()
      const win = ensureWindow()
      // 等 worker 加载完成
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15000
        const check = () => {
          if (win.isDestroyed()) return reject(new Error('OCR 窗口异常关闭'))
          if (Date.now() > deadline) return reject(new Error('OCR 窗口加载超时'))
          win.webContents
            .executeJavaScript('typeof window.__ocrBridge === "object" && typeof window.__ocrBridge.ready === "function"', true)
            .then((ok) => (ok ? resolve() : setTimeout(check, 300)))
            .catch(() => setTimeout(check, 300))
        }
        check()
      })
      const r = await callWorker(
        {
          init: true,
          det: toTransferable(readFileSync(det)),
          rec: toTransferable(readFileSync(rec)),
          keys: toTransferable(readFileSync(keys))
        },
        60000,
        true
      )
      if (!r.ok) throw new Error(r.error || '初始化失败')
      ready = true
      return { enabled: true }
    } catch (e: any) {
      try {
        workerWin?.destroy()
      } catch {}
      workerWin = null
      return { enabled: false, reason: `OCR 初始化失败: ${e?.message || e}` }
    }
  })()
  return initing
}

export function isOcrEnabled(): boolean {
  return ready
}

/** 自测入口：对整图做 det+rec，返回识别文本 */
export async function testRecognize(png: Buffer): Promise<string> {
  const r = await callWorker({ png: toTransferable(png) }, 60000)
  return r.text || ''
}

/** 整页截图 OCR（read_content 降级 / DOM 稀疏兜底） */
export async function ocrPageText(tabManager: TabManager): Promise<string | null> {
  if (!ready) return null
  const tab = tabManager.active()
  if (!tab) return null
  const png = await tab.cdp.screenshotPng()
  if (!png) return null
  try {
    const r = await callWorker({ png: toTransferable(png) }, 45000)
    return r.text ? String(r.text).slice(0, 6000) : null
  } catch {
    return null
  }
}

/**
 * 提取增强钩子：给「无文字的图片类可交互元素」补 OCR 标签。
 * 每页最多处理 10 个区域。
 */
export async function ocrEnhanceExtract(tabManager: TabManager, res: ExtractResult, _png: Buffer | null): Promise<ExtractResult> {
  if (!ready || !res.candidates.length) return res
  const targets = res.candidates
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        (c.role === 'image' || !c.text) &&
        c.rect.w * c.rect.h >= 120 &&
        c.rect.w * c.rect.h <= 60000 &&
        c.inViewport
    )
    .slice(0, 10)
  if (!targets.length) return res
  const tab = tabManager.active()
  if (!tab) return res
  const png = await tab.cdp.screenshotPng()
  if (!png) return res
  try {
    const r = await callWorker(
      { png: toTransferable(png), regions: targets.map(({ c }) => c.rect) },
      30000
    )
    const labels: (string | null)[] = r.labels || []
    targets.forEach(({ i }, k) => {
      const label = labels[k]
      if (label) res.candidates[i] = { ...res.candidates[i], text: `图:${label}` }
    })
  } catch {}
  return res
}
