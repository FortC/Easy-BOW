/**
 * 本地快速决策模型（混合模式的"快脑"）：Qwen2.5-0.5B-Instruct int8 ONNX 本机推理，
 * 用于简单步骤的本地直出决策（同大模型 JSON 契约），不确定时由 runner 门控回退云端。
 *
 * 推理跑在独立的 utilityProcess 子进程（fastllm-worker.ts）：WASM 单线程推理每个
 * token 都是一次同步 CPU 前向计算，在主进程里跑会把窗口卡到「未响应」、退出时进程
 * 残留。主进程只做 RPC 与状态广播；worker 崩溃的最坏后果是本地模型不可用（返回 null，
 * runner 门控自动回退云端），应用无感。
 *
 * 为什么是 WASM 而不是原生 onnxruntime-node：原生库在部分 Windows 机器上
 * 创建推理会话即段错误（v1.1.0 便携版「下载并加载本地模型」闪退的根因，与量化格式无关），
 * WASM 全平台稳定。注入方式：globalThis[Symbol.for('onnxruntime')] 官方后门 +
 * scripts/patch-transformers.mjs 补丁（postinstall 自动执行）——都在 worker 侧完成。
 *
 * 模型优先读安装包内置（resources/fastmodel，随发行版打包，免下载）；
 * 内置缺失（如开发环境未拉取）则回退为首次下载到 userData/models（默认走 hf-mirror 镜像）。
 */
import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { MainEvent } from '@shared/types'

type Broadcast = (ev: MainEvent) => void

/** 本地快速决策模型仓库（onnx-community 预导出量化版） */
export const FAST_MODEL_REPO = 'onnx-community/Qwen2.5-0.5B-Instruct'
/** int8 动态量化（WASM 支持成熟；原生路径的 q4 会触发段错误，见文件头注释） */
export const FAST_MODEL_DTYPE = 'q8'
/** 国内镜像（HuggingFace 直连不可达时的默认源） */
export const HF_MIRROR = 'https://hf-mirror.com'

export interface FastLlmStatus {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  /** 下载/加载进度 0~1 */
  progress?: number
  detail?: string
}

interface Waiter {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer?: NodeJS.Timeout
}

export class FastLlm {
  /** 单次生成超时：本地模型卖点是「秒出」，超 12s 的决策失去加速意义——
   *  超时即丢弃本结果回退云端（旧值 5 分钟等于单步软卡死，且慢结果仍被采纳，见复核 P1-4） */
  private static readonly GEN_TIMEOUT_MS = 12000
  private child: UtilityProcess | null = null
  /** 进行中的 decide/prescreen 作业（id → waiter） */
  private jobs = new Map<number, Waiter>()
  /** 等待 init 完成（ready/error）的 waiter */
  private initWaiters: Waiter[] = []
  private jobId = 1
  status: FastLlmStatus = { state: 'idle' }
  private broadcast: Broadcast
  private lastGenMs = 0
  private disposed = false
  /** 主动 kill 过的 worker（exit 事件晚于重建启动，抑制其误报 error/误拒新 init） */
  private killed = new WeakSet<UtilityProcess>()

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast
  }

  isReady(): boolean {
    return this.status.state === 'ready'
  }

  /** 上一次生成耗时（runner 据此判断本地推理是否真的比云端快） */
  get genMs(): number {
    return this.lastGenMs
  }

  /** 退出清理：杀掉 worker 子进程（模型内存随进程消失，不再拖住主进程退出） */
  dispose(): void {
    this.disposed = true
    for (const [, w] of this.jobs) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new Error('应用退出'))
    }
    this.jobs.clear()
    for (const w of this.initWaiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new Error('应用退出'))
    }
    const c = this.child
    this.child = null
    if (c) {
      try {
        c.postMessage({ t: 'dispose' })
      } catch {}
      // 保险：worker 1.2s 内没自行退出就强杀
      const kill = setTimeout(() => {
        try {
          c.kill()
        } catch {}
      }, 1200)
      ;(kill as unknown as { unref?: () => void }).unref?.()
    }
  }

  private setStatus(s: FastLlmStatus): void {
    this.status = s
    this.broadcast({ channel: 'fastllm', status: s })
  }

  /** 拉起 worker（幂等）；挂接消息与退出处理 */
  private spawn(): UtilityProcess | null {
    if (this.child) return this.child
    try {
      const child = utilityProcess.fork(join(__dirname, 'fastllm-worker.js'), [], { serviceName: 'easybow-fastllm' })
      child.on('message', (msg: any) => this.onMessage(msg))
      child.on('exit', () => {
        // 主动重建（超时 resetWorker）杀掉的旧进程：exit 事件可能晚于新 worker 启动，
        // 不能让它覆盖新状态/拒绝新 init
        if (this.killed.has(child)) {
          this.killed.delete(child)
          return
        }
        if (this.child === child) this.child = null
        for (const [, w] of this.jobs) {
          if (w.timer) clearTimeout(w.timer)
          w.reject(new Error('本地模型进程已退出'))
        }
        this.jobs.clear()
        for (const w of this.initWaiters.splice(0)) {
          if (w.timer) clearTimeout(w.timer)
          w.reject(new Error('本地模型进程已退出'))
        }
        // 就绪/加载中突然退出 = 异常崩溃；error 态不用覆盖（已是失败）
        if (this.status.state === 'ready' || this.status.state === 'loading' || this.status.state === 'downloading') {
          this.setStatus({ state: 'error', detail: '本地模型进程异常退出，已自动回退云端决策（可在设置中重新加载）' })
        }
      })
      this.child = child
      return child
    } catch (e: any) {
      this.setStatus({ state: 'error', detail: `本地模型进程启动失败: ${e?.message || e}` })
      return null
    }
  }

  private onMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'status') {
      const st = msg.status as FastLlmStatus
      this.setStatus(st)
      if (st.state === 'ready' || st.state === 'error') {
        for (const w of this.initWaiters.splice(0)) {
          if (w.timer) clearTimeout(w.timer)
          w.resolve(st)
        }
      }
    } else if (msg.t === 'result') {
      const id = Number(msg.id)
      const w = this.jobs.get(id)
      if (!w) return
      this.jobs.delete(id)
      if (w.timer) clearTimeout(w.timer)
      if (msg.ok) {
        this.lastGenMs = Number(msg.genMs) || 0
        w.resolve(msg.text ?? null)
      } else {
        w.reject(new Error(String(msg.error || '本地推理失败')))
      }
    }
  }

  /** 模型文件根目录（transformers.js 的 cacheDir 布局；供 UI 判断「内置/需下载」） */
  static bundledModelDir(): string | null {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'fastmodel')]
      : [join(__dirname, '../../resources/fastmodel'), join(process.cwd(), 'resources/fastmodel')]
    for (const dir of candidates) {
      // 以权重文件存在为准（其余小文件必在旁边）
      if (existsSync(join(dir, FAST_MODEL_REPO, 'onnx', 'model_quantized.onnx'))) return dir
    }
    return null
  }

  /** 下载（如需）并加载模型（在 worker 进程内执行）；幂等，可重复调用 */
  async init(): Promise<FastLlmStatus> {
    if (this.isReady()) return this.status
    if (this.status.state === 'downloading' || this.status.state === 'loading') return this.status
    if (this.disposed) return this.status
    const child = this.spawn()
    if (!child) return this.status
    const done = new Promise<FastLlmStatus>((resolve, reject) => {
      // 保险丝：worker 既不报 ready 也不退出时（理论不该发生）不无限悬挂
      const timer = setTimeout(() => reject(new Error('本地模型加载超时')), 600000)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.initWaiters.push({ resolve, reject, timer })
    })
    child.postMessage({
      t: 'init',
      modelDir: FastLlm.bundledModelDir(),
      cacheDir: join(app.getPath('userData'), 'models'),
      repo: FAST_MODEL_REPO,
      dtype: FAST_MODEL_DTYPE,
      mirror: HF_MIRROR
    })
    return done.then(
      (st) => st,
      (e) => {
        this.setStatus({ state: 'error', detail: `本地模型加载失败: ${e?.message || e}` })
        return this.status
      }
    )
  }

  /**
   * 超时/卡死后强制重建 worker：卡住的生成无法取消、只会堵住 worker 内的串行队列，
   * 只能整进程换掉。旧作业全部按超时失败回退云端；同时后台重启+重载内置模型
   * （约 3s），就绪后自动恢复本地加速。
   */
  private resetWorker(): void {
    const c = this.child
    this.child = null
    this.status = { state: 'idle' }
    if (c) {
      this.killed.add(c)
      try {
        c.kill()
      } catch {}
    }
    if (!this.disposed) void this.init().catch(() => {})
  }

  /** worker 文本生成（作业带超时保险丝；失败抛错由调用方按原契约降级） */
  private generate(prompt: string, maxNewTokens: number): Promise<string | null> {
    if (!this.isReady() || !this.child) return Promise.resolve(null)
    const id = this.jobId++
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        this.resetWorker()
        reject(new Error(`本地推理超时(${FastLlm.GEN_TIMEOUT_MS / 1000}s)`))
      }, FastLlm.GEN_TIMEOUT_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.jobs.set(id, { resolve, reject, timer })
      this.child!.postMessage({ t: 'decide', id, prompt, maxNewTokens })
    })
  }

  /** 文本推理：chat 模板 + 贪心解码；未就绪/出错返回 null（96 tokens 够 {thought+≤2动作} JSON） */
  async decide(system: string, user: string, maxNewTokens = 96): Promise<string | null> {
    if (!this.isReady()) return null
    return this.generate(`${system}\n\n${user}`, maxNewTokens).catch(() => null)
  }

  /**
   * S6 语义初筛：从候选里挑出与任务最相关的编号（本地模型推理，0 云端 token）。
   * 返回原始编号数组；解析失败/未就绪返回 null（调用方保持全量列表，绝不因初筛失败丢元素）。
   */
  async prescreen(lines: string[], task: string, topK = 12): Promise<number[] | null> {
    if (!this.isReady() || !lines.length) return null
    const list = lines
      .slice(0, 60)
      .map((l, i) => `[${i}] ${String(l).slice(0, 90)}`)
      .join('\n')
    const prompt = `任务：${String(task).slice(0, 150)}\n\n页面元素列表：\n${list}\n\n哪些元素与任务最相关？输出最多 ${topK} 个编号的 JSON 数组，如 [0,3,7]。只输出 JSON 数组：`
    try {
      const out = await this.generate(prompt, 64)
      if (!out) return null
      const m = out.match(/\[[\d\s,，]*\]/)
      if (!m) return null
      const ids = m[0]
        .replace(/[，]/g, ',')
        .replace(/[\[\]]/g, '')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < lines.length)
      return ids.length ? [...new Set(ids)].slice(0, topK) : null
    } catch {
      return null
    }
  }
}

// worker 在 utilityProcess 里自己加载 fs；主进程侧仅 bundledModelDir 用 existsSync 探测内置模型

/**
 * 本地决策校验（纯函数，自测覆盖）：
 * 只放行低风险只读/常规动作，禁止 done（终止决策必须云端）与页签/跳转类；
 * index 必须落在当前候选列表内。返回错误原因或 null（通过）。
 */
export const LOCAL_ALLOWED_ACTIONS = new Set(['click', 'type', 'scroll', 'wait', 'read_content', 'save', 'recall'])

export function validateLocalActions(
  parsed: { thought: string; actions: any[] } | null,
  candidateCount: number
): string | null {
  if (!parsed) return '输出不是合法 JSON'
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) return 'actions 为空'
  if (parsed.actions.length > 2) return '动作数超过 2（本地只做简单步骤）'
  for (const a of parsed.actions) {
    if (!a || typeof a.name !== 'string') return '动作缺少 name'
    if (!LOCAL_ALLOWED_ACTIONS.has(a.name)) return `本地不允许动作 ${a.name}（done/跳转/粘贴类必须云端决策）`
    if ((a.name === 'click' || a.name === 'type') && typeof a.index !== 'number') return `${a.name} 缺少 index`
    if (typeof a.index === 'number' && (a.index < 0 || a.index >= candidateCount)) return `index ${a.index} 超出候选范围(0~${candidateCount - 1})`
    if (a.name === 'type' && (a.text == null || !String(a.text).length)) return 'type 缺少 text'
  }
  return null
}
