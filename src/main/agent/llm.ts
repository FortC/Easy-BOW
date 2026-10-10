import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { Settings } from '@shared/types'
import {
  STEP_SCHEMA,
  responseFormatFor,
  probeStructuredSupport,
  clearStructuredCache,
  downgradeStructured,
  forceStructuredNone,
  isToolUseAvailable,
  markToolUseUnavailable,
  isResponseFormatError,
  isToolUseCompatError,
  type StructuredSupport
} from './structured'

// W3 结构化输出：对外透出探测/清理入口（预检与缓存实现见 structured.ts）
export { probeStructuredSupport, clearStructuredCache }
export type { StructuredSupport }

/** 消息内容块：文本 或 图片（dataURL），用于用户截图指路等多模态输入 */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface LlmResult {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  /** 本次实际使用的结构化模式（可选，不传也合法） */
  structured?: StructuredSupport
}

export interface LlmProvider {
  chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult>
}

const TIMEOUT_MS = 90000

/** 1x1 PNG 测试图（llm:test 探测模型是否接受图片输入用） */
export const TINY_TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** ContentPart[] → OpenAI content 格式（文本 + image_url dataURL）；导出供自测 */
export function toOpenAiContent(content: string | ContentPart[]): string | any[] {
  if (typeof content === 'string') return content
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.dataUrl } }
  )
}

/** OpenAI 兼容协议（OpenAI/DeepSeek/GLM/Kimi/OpenRouter/Ollama 等自定义 baseURL） */
export class OpenAIProvider implements LlmProvider {
  private client: OpenAI
  private model: string
  private settings: Settings

  constructor(settings: Settings) {
    this.client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      timeout: TIMEOUT_MS,
      // 不让 SDK 静默重试：超时/网络错误直接抛给 Agent 循环，
      // 由模型在下一步看到错误自行决定重试（否则挂死请求会拖 2 倍超时时长）
      maxRetries: 0
    })
    this.model = settings.model
    this.settings = settings
  }

  async chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult> {
    // 基础请求体与旧版逐字节一致；response_format 仅在结构化启用时才附加
    const buildReq = (fmt: any): any => {
      const req: any = {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          ...messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) }))
        ],
        temperature: 0.2,
        max_tokens: 2048
      }
      if (fmt) req.response_format = fmt
      return req
    }
    const finish = (res: any, structured: StructuredSupport): LlmResult => {
      const text = res.choices?.[0]?.message?.content || ''
      return {
        text: typeof text === 'string' ? text : JSON.stringify(text),
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0
        },
        structured
      }
    }

    // W3 结构化输出：关闭或探测不支持时走纯文本（请求体与现状逐字节一致）
    const mode = this.settings.structuredOut !== false ? await probeStructuredSupport(this.settings) : 'none'
    if (mode === 'none') {
      const res = await this.client.chat.completions.create(buildReq(undefined), { signal })
      return finish(res, 'none')
    }
    try {
      const res = await this.client.chat.completions.create(buildReq(responseFormatFor(mode)), { signal })
      return finish(res, mode)
    } catch (e) {
      if (!isResponseFormatError(e)) throw e
      // response_format 不支持/参数错：缓存降级一档，原参数（其余不变）重试一次
      const m2 = downgradeStructured(this.settings)
      try {
        const res = await this.client.chat.completions.create(buildReq(responseFormatFor(m2)), { signal })
        return finish(res, m2)
      } catch (e2) {
        if (m2 === 'none') throw e2
        // 重试仍失败：按原有纯文本行为返回
        forceStructuredNone(this.settings)
        const res = await this.client.chat.completions.create(buildReq(undefined), { signal })
        return finish(res, 'none')
      }
    }
  }
}

/** ContentPart[] → Anthropic content 格式（文本 + base64 image block）；导出供自测 */
export function toAnthropicContent(content: string | ContentPart[]): string | any[] {
  if (typeof content === 'string') return content
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    // dataUrl 形如 data:image/jpeg;base64,xxxx
    const m = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i.exec(p.dataUrl)
    if (!m) return { type: 'text', text: '(不支持的图片格式，已忽略)' }
    const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase()
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } }
  })
}

/** Anthropic 兼容协议（Anthropic 官方或兼容中转） */
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic
  private model: string
  private settings: Settings

  constructor(settings: Settings) {
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      timeout: TIMEOUT_MS,
      maxRetries: 0
    })
    this.model = settings.model
    this.settings = settings
  }

  async chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult> {
    // 基础请求体与旧版逐字节一致（system 保留 cache_control 提示词缓存，与 tool_use 兼容）
    const baseReq: any = {
      model: this.model,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      max_tokens: 2048,
      temperature: 0.2
    }
    const finishText = (res: any, structured: StructuredSupport): LlmResult => {
      const text = (res.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
      return {
        text,
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
        structured
      }
    }

    // W3 结构化输出：关闭或已标记 tool_use 不可用时走纯文本（请求体与现状逐字节一致）
    const useTool = this.settings.structuredOut !== false && isToolUseAvailable(this.settings)
    if (!useTool) {
      const res = await this.client.messages.create(baseReq, { signal })
      return finishText(res, 'none')
    }
    try {
      const res: any = await this.client.messages.create(
        {
          ...baseReq,
          // 强制 submit_step tool_use：input 即 schema 约束的 JSON 对象，stringify 后交上层 parseModelJson 解析
          tools: [
            {
              name: 'submit_step',
              description: '提交本步输出：thought 思考、actions 动作数组、node_done 节点是否达成',
              input_schema: STEP_SCHEMA
            }
          ],
          tool_choice: { type: 'tool', name: 'submit_step' }
        },
        { signal }
      )
      const toolBlock = (res.content || []).find((b: any) => b.type === 'tool_use')
      if (toolBlock && toolBlock.input != null) {
        return {
          text: JSON.stringify(toolBlock.input),
          usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
          structured: 'json_schema'
        }
      }
      // 中转忽略 tool_choice 未返回 tool_use：退回文本
      return finishText(res, 'none')
    } catch (e) {
      if (!isToolUseCompatError(e)) throw e
      // tool_use/中转兼容性报错：标记该 baseURL|model 不再带 tools，降回纯文本重试一次
      markToolUseUnavailable(this.settings)
      const res = await this.client.messages.create(baseReq, { signal })
      return finishText(res, 'none')
    }
  }
}

export function createProvider(settings: Settings): LlmProvider {
  if (!settings.apiKey) throw new Error('尚未配置 API Key，请先在「设置」中填写接口信息')
  if (!settings.model) throw new Error('尚未配置模型名称')
  return settings.provider === 'anthropic' ? new AnthropicProvider(settings) : new OpenAIProvider(settings)
}

/** T10 planner 是否已配置：planner 里至少 model 或 apiKey 非空 */
export function hasPlannerConfig(settings: Settings): boolean {
  const p = settings.planner
  if (!p) return false
  return !!(p.model && p.model.trim()) || !!(p.apiKey && p.apiKey.trim())
}

/**
 * planner 专用提供器：把 settings.planner 的 provider/baseURL/apiKey/model 逐字段覆盖主配置
 * （缺省字段跟随主配置）。planner 只用于重规划/L2 复核/专家重试，绝不参与逐步执行。
 */
export function createPlannerProvider(settings: Settings): LlmProvider {
  const p = settings.planner || {}
  const pick = (v: string | undefined, fallback: string): string => (v && v.trim() ? v : fallback)
  const effective: Settings = {
    ...settings,
    provider: p.provider ?? settings.provider,
    baseURL: pick(p.baseURL, settings.baseURL),
    apiKey: pick(p.apiKey, settings.apiKey),
    model: pick(p.model, settings.model)
  }
  if (!effective.apiKey || !effective.apiKey.trim()) throw new Error('planner 未配置 API Key')
  return createProvider(effective)
}

/**
 * 判定「模型不支持图片输入」类错误（仅在消息里带了图片时调用）：
 * 纯文本模型遇到 image 块时，常见 HTTP 400/415/422，或错误文案明确提到图片/多模态不支持。
 * 命中则视觉模式降级为纯文本，避免每步都撞一次报错。
 */
export function isVisionUnsupportedError(e: any): boolean {
  if (!e) return false
  const status = typeof e.status === 'number' ? e.status : typeof e?.response?.status === 'number' ? e.response.status : NaN
  if ([400, 415, 422].includes(status)) return true
  const msg = String(e?.message || e || '')
  return /(不支持|无法处理|无法识别)[^\n]{0,20}(图片|图像|视觉|多模态)|(image|vision|multimodal|multi-modal)[^\n]{0,40}(not supported|unsupported)/i.test(
    msg
  )
}
