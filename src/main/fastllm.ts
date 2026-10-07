/**
 * 本地快速决策模型（混合模式的"快脑"）：
 * Qwen2.5-0.5B-Instruct int4 ONNX 经 onnxruntime-node（N-API，CPU）在本机推理，
 * 用于简单步骤的本地直出决策（同大模型 JSON 契约），不确定时由 runner 门控回退云端。
 *
 * 模型不入安装包：首次下载到 userData/models（默认走 hf-mirror 国内镜像）。
 */
import { app } from 'electron'
import { join } from 'path'
import type { MainEvent } from '@shared/types'

type Broadcast = (ev: MainEvent) => void

/** 本地快速决策模型仓库（onnx-community 预导出 int4 量化） */
export const FAST_MODEL_REPO = 'onnx-community/Qwen2.5-0.5B-Instruct'
export const FAST_MODEL_DTYPE = 'q4'
/** 国内镜像（HuggingFace 直连不可达时的默认源） */
export const HF_MIRROR = 'https://hf-mirror.com'

export interface FastLlmStatus {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  /** 下载/加载进度 0~1 */
  progress?: number
  detail?: string
}

type AnyPipeline = any

export class FastLlm {
  private model: AnyPipeline | null = null
  private tokenizer: any = null
  private loading = false
  status: FastLlmStatus = { state: 'idle' }
  private broadcast: Broadcast
  private lastGenMs = 0

  constructor(broadcast: Broadcast) {
    this.broadcast = broadcast
  }

  isReady(): boolean {
    return this.status.state === 'ready' && !!this.model
  }

  /** 上一次生成耗时（runner 据此判断本地推理是否真的比云端快） */
  get genMs(): number {
    return this.lastGenMs
  }

  private setStatus(s: FastLlmStatus): void {
    this.status = s
    this.broadcast({ channel: 'fastllm', status: s })
  }

  /** 下载（如需）并加载模型；幂等，可重复调用 */
  async init(): Promise<FastLlmStatus> {
    if (this.isReady()) return this.status
    if (this.loading) return this.status
    this.loading = true
    try {
      this.setStatus({ state: 'downloading', progress: 0, detail: `准备下载 ${FAST_MODEL_REPO}（int4，约 400MB，来源 hf-mirror）` })
      // transformers.js 为 ESM-only：主进程 CJS 下用动态 import
      const tf = await import('@huggingface/transformers')
      tf.env.cacheDir = join(app.getPath('userData'), 'models', '/')
      tf.env.remoteHost = HF_MIRROR
      // 本机已有缓存时不重复下载；进度回调驱动 UI
      const progress = (p: any) => {
        if (p?.status === 'progress' && p.total) {
          this.setStatus({ state: 'downloading', progress: p.loaded / p.total, detail: `下载 ${p.file || ''} ${(p.loaded / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(0)}MB` })
        } else if (p?.status === 'ready' || p?.status === 'done') {
          this.setStatus({ state: 'loading', progress: 1, detail: '模型下载完成，加载中…' })
        }
      }
      this.tokenizer = await tf.AutoTokenizer.from_pretrained(FAST_MODEL_REPO, { progress_callback: progress })
      this.setStatus({ state: 'loading', progress: 1, detail: '加载模型权重到内存…' })
      this.model = await tf.AutoModelForCausalLM.from_pretrained(FAST_MODEL_REPO, {
        dtype: FAST_MODEL_DTYPE,
        device: 'cpu',
        progress_callback: progress
      })
      // 预热一次，避免首个决策承担图优化耗时
      this.setStatus({ state: 'loading', progress: 1, detail: '预热中…' })
      await this.decideInternal('输出 {"ok":1}', 16)
      this.setStatus({ state: 'ready', detail: '本地快速决策模型就绪（Qwen2.5-0.5B int4）' })
      return this.status
    } catch (e: any) {
      this.model = null
      this.tokenizer = null
      this.setStatus({ state: 'error', detail: `本地模型加载失败: ${e?.message || e}` })
      return this.status
    } finally {
      this.loading = false
    }
  }

  /** 文本推理：chat 模板 + 贪心解码；未就绪/出错返回 null */
  async decide(system: string, user: string, maxNewTokens = 140): Promise<string | null> {
    if (!this.isReady()) return null
    return this.decideInternal(`${system}\n\n${user}`, maxNewTokens)
  }

  private async decideInternal(prompt: string, maxNewTokens: number): Promise<string | null> {
    if (!this.model || !this.tokenizer) return null
    try {
      const messages = [
        { role: 'system', content: '你是浏览器自动化助手，只输出纯 JSON。' },
        { role: 'user', content: prompt }
      ]
      const input = await this.tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        return_dict: true
      })
      const t0 = Date.now()
      const out = await this.model.generate({
        ...input,
        max_new_tokens: maxNewTokens,
        do_sample: false
      })
      // batch_decode 官方模式；解码结果含提示词回声，由 runner 的宽松 JSON 解析截取
      const text = this.tokenizer.batch_decode(out, { skip_special_tokens: true })[0] || ''
      this.lastGenMs = Date.now() - t0
      return text
    } catch {
      return null
    }
  }
}

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
