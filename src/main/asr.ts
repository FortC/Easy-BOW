/**
 * 本地语音识别（v4.4 语音输入）：whisper-base int8 ONNX 本机推理（WASM），
 * 把麦克风录音转文字填入任务输入框。离线免费，与「本地免费」产品定位一致。
 *
 * 与 FastLlm 同构：推理跑在独立 utilityProcess（asr-worker.ts）——WASM 单线程转写
 * 是同步 CPU 前向计算，在主进程里跑会把整个应用卡死几秒。worker 崩溃的最坏后果是
 * 本次转写失败（返回错误给按钮），应用无感。
 *
 * 模型只走安装包内置（resources/asr/whisper-base，scripts/fetch-asr-model.mjs 构建前拉取）；
 * 缺失（开发环境未拉取）时给出明确指引，不做在线下载（v4.4 选型：模型内置）。
 */
import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { MainEvent } from '@shared/types'

type Broadcast = (ev: MainEvent) => void

export interface AsrStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  detail?: string
}

interface Waiter {
  resolve: (v: string) => void
  reject: (e: Error) => void
  timer?: NodeJS.Timeout
}

export class Asr {
  /** 单次转写超时：whisper int8 WASM 约 2~8 倍实时，90s 录音给 3 分钟上限 */
  private static readonly TRANSCRIBE_TIMEOUT_MS = 180000
  private child: UtilityProcess | null = null
  private jobs = new Map<number, Waiter>()
  private initWaiters: Waiter[] = []
  private jobId = 1
  status: AsrStatus = { state: 'idle' }
  private broadcast: Broadcast
  private disposed = false
  private killed = new Set<UtilityProcess>()

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast
  }

  /** 内置模型目录（null=未拉取，开发环境需先跑 scripts/fetch-asr-model.mjs） */
  static bundledModelDir(): string | null {
    const dir = app.isPackaged
      ? join(process.resourcesPath, 'asr', 'whisper-base')
      : join(__dirname, '../../resources/asr/whisper-base')
    return existsSync(join(dir, 'config.json')) ? dir : null
  }

  private setStatus(s: AsrStatus): void {
    this.status = s
    this.broadcast({ channel: 'asr', status: s })
  }

  /** 拉起 worker（幂等）；挂接消息与退出处理（与 FastLlm.spawn 同构） */
  private spawn(): UtilityProcess | null {
    if (this.child) return this.child
    try {
      const child = utilityProcess.fork(join(__dirname, 'asr-worker.js'), [], { serviceName: 'easybow-asr' })
      child.on('message', (msg: any) => this.onMessage(msg))
      child.on('exit', () => {
        if (this.killed.has(child)) {
          this.killed.delete(child)
          return
        }
        if (this.child === child) this.child = null
        for (const [, w] of this.jobs) {
          if (w.timer) clearTimeout(w.timer)
          w.reject(new Error('语音识别进程已退出'))
        }
        this.jobs.clear()
        for (const w of this.initWaiters.splice(0)) {
          if (w.timer) clearTimeout(w.timer)
          w.reject(new Error('语音识别进程已退出'))
        }
        if (this.status.state === 'ready' || this.status.state === 'loading') {
          this.setStatus({ state: 'error', detail: '语音识别进程异常退出，请重试' })
        }
      })
      this.child = child
      return child
    } catch (e: any) {
      this.setStatus({ state: 'error', detail: `语音识别进程启动失败: ${e?.message || e}` })
      return null
    }
  }

  private onMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'status') {
      const st = msg.status as AsrStatus
      this.setStatus(st)
      if (st.state === 'ready' || st.state === 'error') {
        for (const w of this.initWaiters.splice(0)) {
          if (w.timer) clearTimeout(w.timer)
          st.state === 'ready' ? w.resolve('ready') : w.reject(new Error(st.detail || '语音模型加载失败'))
        }
      }
      return
    }
    if (msg.t === 'result') {
      const w = this.jobs.get(Number(msg.id))
      if (!w) return
      this.jobs.delete(Number(msg.id))
      if (w.timer) clearTimeout(w.timer)
      if (msg.ok) w.resolve(String(msg.text || ''))
      else w.reject(new Error(String(msg.error || '转写失败')))
    }
  }

  /** 确保模型加载完成（首次调用触发；失败会拒绝并给明确原因） */
  private ensureInit(modelDir: string): Promise<string> {
    if (this.status.state === 'ready') return Promise.resolve('ready')
    const child = this.spawn()
    if (!child) return Promise.reject(new Error('语音识别进程启动失败'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.initWaiters.findIndex((w) => w.resolve === resolve)
        if (i >= 0) this.initWaiters.splice(i, 1)
        reject(new Error('语音模型加载超时'))
      }, 120000)
      this.initWaiters.push({ resolve, reject, timer })
      if (this.status.state === 'idle' || this.status.state === 'error') {
        this.setStatus({ state: 'loading', detail: '加载语音识别模型…' })
        child.postMessage({ t: 'init', modelDir })
      }
    })
  }

  /**
   * 转写一段 PCM（Float32Array，16kHz 单声道）→ 文本。
   * 模型缺失/加载失败/超时都会以异常抛出（按钮显示原因，不静默）。
   */
  async transcribe(pcm: Float32Array, sampleRate = 16000): Promise<string> {
    if (this.disposed) throw new Error('语音识别已释放')
    const modelDir = Asr.bundledModelDir()
    if (!modelDir) {
      throw new Error('语音模型缺失（开发环境请先运行 node scripts/fetch-asr-model.mjs）')
    }
    await this.ensureInit(modelDir)
    const child = this.child
    if (!child) throw new Error('语音识别进程不可用')
    const id = this.jobId++
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        reject(new Error('语音转写超时'))
      }, Asr.TRANSCRIBE_TIMEOUT_MS)
      this.jobs.set(id, { resolve, reject, timer })
      child.postMessage({ t: 'transcribe', id, pcm, sampleRate })
    })
  }

  /** 应用退出释放（utilityProcess 随主进程退出，这里只做状态收尾） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.child?.postMessage({ t: 'dispose' })
    } catch {}
    this.child = null
  }
}
